// voice/vad.js — Silero VAD integration for AetherMesh ASR
// Provides voice activity detection to replace simple silence-timeout-based
// auto-send with neural VAD. Filters out non-speech before sending to ASR,
// and signals speech-end for immediate flush instead of waiting for timeout.
//
// Usage:
//   const { createVADSession } = require('./voice/vad.js')
//   const vad = await createVADSession({ threshold: 0.5, minSpeechMs: 300, minSilenceMs: 600, speechPadMs: 50 })
//   const result = vad.processChunk(float32Frame) // returns { speech, state }
//   vad.reset()
//   vad.getBuffer() // returns accumulated Float32Array
//   vad.release()   // cleanup

import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { loadSileroVad } = require('@jjhbw/silero-vad')

// States for the VAD state machine
const STATE = Object.freeze({
  SILENCE: 'silence',
  SPEECH_START: 'speech_start',
  SPEECH: 'speech',
  SPEECH_END: 'speech_end',
})

const SAMPLE_RATE = 16000
const FRAME_SIZE = 512 // Silero VAD 16kHz model: 512 samples = 32ms per frame

/**
 * Create a VAD session that wraps Silero VAD with a state machine.
 * @param {Object} opts
 * @param {number} [opts.threshold=0.5] Speech probability threshold
 * @param {number} [opts.minSpeechMs=300] Minimum speech duration to accept (prevents clicks)
 * @param {number} [opts.minSilenceMs=600] Silence duration before flushing (how long after speech ends to wait)
 * @param {number} [opts.speechPadMs=50] Extra frames to keep before/after speech boundaries
 * @returns {Promise<Object>} VAD session
 */
async function createVADSession(opts = {}) {
  const threshold = opts.threshold ?? 0.5
  const minSpeechFrames = Math.ceil((opts.minSpeechMs ?? 300) / (FRAME_SIZE / SAMPLE_RATE * 1000))
  const minSilenceFrames = Math.ceil((opts.minSilenceMs ?? 600) / (FRAME_SIZE / SAMPLE_RATE * 1000))
  const padFrames = Math.ceil((opts.speechPadMs ?? 50) / (FRAME_SIZE / SAMPLE_RATE * 1000))

  const vad = await loadSileroVad('default', {
    sessionOptions: {
      intraOpNumThreads: 2,
      interOpNumThreads: 1,
      executionMode: 'sequential',
      graphOptimizationLevel: 'all',
    }
  })

  let state = STATE.SILENCE
  let speechFrames = 0       // consecutive frames above threshold
  let silenceFrames = 0      // consecutive frames below threshold (after speech)
  let accumulated = []       // Float32Array chunks during speech
  let pendingPreSpeech = []  // frames right before speech crossed threshold (for padding)
  let speechCount = 0        // total frames in current speech segment

  function reset() {
    state = STATE.SILENCE
    speechFrames = 0
    silenceFrames = 0
    accumulated = []
    pendingPreSpeech = []
    speechCount = 0
    vad.resetStates()
  }

  /**
   * Process a single 512-sample Float32Array frame (16kHz).
   * @param {Float32Array} frame Exactly 512 samples
   * @returns {{ speech: boolean, state: string, flush: boolean, prob: number }}
   *   speech: whether we consider the current frame to contain speech overall
   *   state: current VAD state machine state
   *   flush: true when a speech segment just ended (caller should send to ASR)
   *   prob: raw Silero probability for this frame
   */
  async function processChunk(frame) {
    if (frame.length !== FRAME_SIZE) {
      // Pad or truncate to 512 samples
      const buf = new Float32Array(FRAME_SIZE)
      buf.set(frame.slice(0, FRAME_SIZE))
      frame = buf
    }

    const prob = await vad.processChunk(frame, SAMPLE_RATE)
    const isSpeech = prob >= threshold

    let flush = false

    switch (state) {
      case STATE.SILENCE:
        if (isSpeech) {
          speechFrames++
          pendingPreSpeech.push(frame)
          // Keep only the last padFrames pre-speech frames
          if (pendingPreSpeech.length > padFrames) {
            pendingPreSpeech.shift()
          }
          if (speechFrames >= Math.max(2, Math.ceil(minSpeechFrames / 2))) {
            // Transition to SPEECH_START after a few speech frames
            state = STATE.SPEECH_START
          }
        } else {
          speechFrames = 0
          pendingPreSpeech = []
        }
        break

      case STATE.SPEECH_START:
        if (isSpeech) {
          speechFrames++
          speechCount++
          // Flush pre-speech padding into accumulator
          if (accumulated.length === 0) {
            for (const f of pendingPreSpeech) {
              accumulated.push(f)
            }
          }
          accumulated.push(frame)
          if (speechFrames >= minSpeechFrames) {
            state = STATE.SPEECH
          }
        } else {
          // False start: didn't reach min speech duration
          speechFrames = 0
          speechCount = 0
          accumulated = []
          pendingPreSpeech = []
          state = STATE.SILENCE
        }
        break

      case STATE.SPEECH:
        if (isSpeech) {
          speechCount++
          accumulated.push(frame)
          silenceFrames = 0
        } else {
          silenceFrames++
          // Keep accumulating during silence (for padding)
          accumulated.push(frame)
          if (silenceFrames >= minSilenceFrames) {
            // Speech ended. Trim trailing silence frames (keep padFrames)
            const trimFrames = Math.max(0, silenceFrames - padFrames)
            if (trimFrames > 0) {
              accumulated.splice(accumulated.length - trimFrames, trimFrames)
            }
            flush = true
            state = STATE.SPEECH_END
          }
        }
        break

      case STATE.SPEECH_END:
        // After flush, reset if still silence, or restart if speech again
        if (isSpeech) {
          accumulated = [frame]
          speechCount = 1
          silenceFrames = 0
          state = STATE.SPEECH
          flush = false
        } else {
          // Stay in SPEECH_END until first speech frame
          // (reset handled by caller after getBuffer)
        }
        break
    }

    return { speech: state !== STATE.SILENCE, state, flush, prob }
  }

  /**
   * Get accumulated PCM buffer (Int16Array) for the current speech segment.
   * Converts Float32 → Int16.
   */
  function getBuffer() {
    if (!accumulated.length) return null
    const totalSamples = accumulated.reduce((sum, f) => sum + f.length, 0)
    const f32 = new Float32Array(totalSamples)
    let offset = 0
    for (const f of accumulated) {
      f32.set(f, offset)
      offset += f.length
    }
    // Convert to Int16
    const i16 = new Int16Array(totalSamples)
    for (let i = 0; i < totalSamples; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]))
      i16[i] = s < 0 ? s * 32768 : s * 32767
    }
    return i16
  }

  async function release() {
    if (vad?.session) {
      try { await vad.session.release() } catch {}
    }
  }

  return {
    processChunk,
    getBuffer,
    reset,
    release,
    STATE,
    SAMPLE_RATE,
    FRAME_SIZE,
  }
}

export { createVADSession, STATE, SAMPLE_RATE, FRAME_SIZE }