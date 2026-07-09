import path from 'path'
import fs from 'fs'
import http from 'http'
import https from 'https'
import FormData from 'form-data'
import sharp from 'sharp'
import { requestJson } from './http.js'
import { env } from './utils.js'
import { paths } from '../paths.js'
import { getVoiceConfig, getTTSCredentials } from '../config.js'
import { streamTTS } from '../voice/tts-providers.js'

const POLL_INTERVAL_MS = 2000
const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 60000

// Track chat IDs whose last incoming message was voice → reply with voice
const voiceReplyChats = new Set()

// Per-chat voice reply mode: 'auto' (follow input) | 'on' (always voice) | 'off' (always text)
const voiceModes = new Map()

export async function startTelegramConnector({ pushMessage, emitEvent } = {}) {
  const token = env('TELEGRAM_BOT_TOKEN')
  if (!token) return null

  const apiBase = `https://api.telegram.org/bot${token}`
  let stopped = false
  let pollTimer = null
  let reconnectAttempt = 0
  let lastUpdateId = 0
  let reconnectTimer = null

  function clearTimers() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  }

  async function downloadTelegramFileBuffer(fileId) {
    const fileInfo = await requestJson(`${apiBase}/getFile?file_id=${encodeURIComponent(fileId)}`)
    if (!fileInfo.ok || !fileInfo.data?.ok || !fileInfo.data?.result?.file_path) {
      throw new Error(`Telegram getFile failed: ${fileInfo.text}`)
    }
    const filePath = fileInfo.data.result.file_path
    const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`
    const resp = await fetch(fileUrl)
    if (!resp.ok) throw new Error(`Telegram file download failed HTTP ${resp.status}`)
    return Buffer.from(await resp.arrayBuffer())
  }

  async function transcribeAudio(audioBuffer, ext) {
    try {
      const cfg = getVoiceConfig()
      const baseURL = (cfg.aethermeshBaseURL || '').replace(/\/+$/, '')
      if (!baseURL) {
        console.log(`[Telegram] ▼ ASR skipped: aethermeshBaseURL not configured`)
        return null
      }
      const apiKey = cfg.aethermeshKey || ''
      const model = cfg.aethermeshAsrModel || 'whisper-large-v3'

      const fd = new FormData()
      fd.append('file', audioBuffer, { filename: `voice${ext}`, contentType: 'audio/ogg' })
      fd.append('model', model)
      fd.append('response_format', 'json')

      const url = `${baseURL}/v1/audio/transcriptions`
      console.log(`[Telegram] ▼ ASR request: POST ${url} model=${model} audio=${(audioBuffer.length / 1024).toFixed(1)}KB auth=${apiKey ? 'yes' : 'no'}`)

      const extraHeaders = {}
      if (apiKey) {
        extraHeaders['Authorization'] = `Bearer ${apiKey}`
        fd.append('api_key', apiKey) // also try as form field
      }
      const resp = await multipartRequest(url, fd, 60000, extraHeaders)
      if (!resp.ok) {
        console.warn(`[Telegram] ▼ ASR HTTP ${resp.status}: body=${(resp.text || '').slice(0, 300)}`)
        return null
      }
      console.log(`[Telegram] ▼ ASR response:`, JSON.stringify(resp.data))
      const text = (resp.data?.text || '').trim()
      return text || null
    } catch (err) {
      console.warn(`[Telegram] ▼ ASR exception:`, err.message)
      return null
    }
  }

  async function getMe() {
    const res = await requestJson(`${apiBase}/getMe`)
    return res.ok && res.data?.ok
  }

  async function poll() {
    if (stopped) return
    try {
      const params = { timeout: 10, offset: lastUpdateId + 1, allowed_updates: ['message'] }
      const res = await requestJson(`${apiBase}/getUpdates?${new URLSearchParams(params)}`, { timeoutMs: 25000 })
      if (!res.ok || !res.data?.ok) return

      const updates = res.data.result || []
      for (const update of updates) {
        if (update.update_id >= lastUpdateId) lastUpdateId = update.update_id

        const msg = update.message
        if (!msg || msg.from?.is_bot) continue

        const chatId = String(msg.chat.id)
        let content = msg.text || msg.caption || ''
        const mediaMarkdowns = []

        // Download photos (largest available size)
        if (msg.photo?.length > 0) {
          try {
            const largest = msg.photo[msg.photo.length - 1]
            const buffer = await downloadTelegramFileBuffer(largest.file_id)
            // Compress image: resize to max 800px width, 80% JPEG quality to reduce base64 size
            const compressed = await sharp(buffer)
              .resize(800, null, { withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toBuffer()
            const base64 = compressed.toString('base64')
            mediaMarkdowns.push(`![telegram photo](data:image/jpeg;base64,${base64})`)
          } catch (err) {
            console.warn('[Telegram] photo download failed:', err.message)
          }
        }

        // Download image-type documents
        if (msg.document?.mime_type?.startsWith('image/')) {
          try {
            const mime = msg.document.mime_type || 'image/jpeg'
            const buffer = await downloadTelegramFileBuffer(msg.document.file_id)
            const isJpeg = mime === 'image/jpeg'
            const compressed = isJpeg
              ? await sharp(buffer).resize(800, null, { withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()
              : await sharp(buffer).resize(800, null, { withoutEnlargement: true }).png({ compressionLevel: 8 }).toBuffer()
            const base64 = compressed.toString('base64')
            mediaMarkdowns.push(`![${msg.document.file_name || 'telegram image'}](data:${mime};base64,${base64})`)
          } catch (err) {
            console.warn('[Telegram] image document download failed:', err.message)
          }
        }

        // Download and transcribe voice messages via AetherMesh Whisper
        if (msg.voice) {
          voiceReplyChats.add(chatId)
          console.log(`[Telegram] ▼ voice received: file_id=${msg.voice.file_id}, duration=${msg.voice.duration}s, size=${msg.voice.file_size}`)
          try {
            const buffer = await downloadTelegramFileBuffer(msg.voice.file_id)
            console.log(`[Telegram] ▼ audio downloaded: ${(buffer.length / 1024).toFixed(1)}KB`)
            const transcribed = await transcribeAudio(buffer, '.ogg')
            if (transcribed) {
              content = transcribed
              console.log(`[Telegram] ▼ ASR result: "${transcribed}"`)
            } else {
              console.log(`[Telegram] ▼ ASR returned null/empty, using placeholder`)
              content = `[语音消息 ${msg.voice.duration || '?'}s]`
            }
          } catch (err) {
            console.warn(`[Telegram] ▼ voice exception:`, err.message)
            content = `[语音消息 ${msg.voice.duration || '?'}s]`
          }
        }

        // Handle /voice command: set per-chat voice reply mode
        if (/^\/voice\b/.test(content)) {
          console.log(`[Telegram] /voice command received: "${content}" from chat ${chatId}`)
          const mode = content.trim().split(/\s+/)[1] || ''
          const validModes = { auto: 'auto', on: 'on', off: 'off' }
          if (validModes[mode]) {
            voiceModes.set(chatId, validModes[mode])
            const reply = mode === 'on' ? '✅ 語音回覆：開啟（一律語音）'
              : mode === 'off' ? '✅ 語音回覆：關閉（一律文字）'
              : '✅ 語音回覆：自動（跟隨輸入模式）'
            const token = env('TELEGRAM_BOT_TOKEN')
            requestJson(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'POST', body: { chat_id: Number(chatId), text: reply },
            }).catch(() => {})
          } else {
            const token = env('TELEGRAM_BOT_TOKEN')
            requestJson(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'POST', body: { chat_id: Number(chatId), text: '用法：\n/voice auto — 跟隨輸入模式\n/voice on — 強制語音回覆\n/voice off — 強制文字回覆' },
            }).catch(() => {})
          }
          continue // don't forward to LLM
        }

        if (!content && mediaMarkdowns.length === 0) continue

        const fullContent = [...mediaMarkdowns, content].filter(Boolean).join('\n\n')
        const fromId = `telegram:${chatId}`
        console.log(`[Telegram] ▼ push to LLM: content="${fullContent}" chatId=${chatId}`)
        pushMessage(fromId, fullContent, 'TELEGRAM', {
          social: { platform: 'telegram', chat_id: chatId, message_id: msg.message_id },
        })
        emitEvent?.('message_in', {
          from_id: fromId,
          content: fullContent,
          channel: 'TELEGRAM',
          timestamp: new Date().toISOString(),
        })
      }

      reconnectAttempt = 0
      if (!stopped) pollTimer = setTimeout(poll, POLL_INTERVAL_MS)
    } catch (err) {
      emitEvent?.('social_status', { platform: 'telegram', status: 'poll_error', error: err.message })
      scheduleReconnect()
    }
  }

  function scheduleReconnect() {
    if (stopped) return
    clearTimers()
    const jitter = Math.random() * 0.3 + 0.85
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt * jitter, RECONNECT_MAX_MS)
    reconnectAttempt++
    reconnectTimer = setTimeout(poll, delay)
    reconnectTimer.unref?.()
  }

  try {
    const me = await getMe()
    if (!me) {
      emitEvent?.('social_status', { platform: 'telegram', status: 'error', error: 'invalid bot token' })
      return null
    }
    emitEvent?.('social_status', { platform: 'telegram', status: 'ready' })
    poll()
  } catch (err) {
    emitEvent?.('social_status', { platform: 'telegram', status: 'error', error: err.message })
    return null
  }

  return {
    platform: 'telegram',
    stop() {
      stopped = true
      clearTimers()
    },
  }
}

/**
 * Send a Telegram chat action (e.g. typing indicator).
 * Each call shows the indicator for ~5 seconds; callers should refresh periodically.
 */
export async function sendTelegramChatAction(chatId, action = 'typing') {
  const token = env('TELEGRAM_BOT_TOKEN')
  if (!token) return
  try {
    await requestJson(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: 'POST',
      body: { chat_id: Number(chatId), action },
    })
  } catch (err) {
    // Typing failures are non-fatal
    console.debug('[Telegram] sendChatAction failed:', err.message)
  }
}

/**
 * Start a periodic typing indicator for a Telegram chat.
 * Returns an object with a stop() method to cancel it.
 */
export function startTelegramTyping(chatId) {
  const token = env('TELEGRAM_BOT_TOKEN')
  if (!token) return { stop() {} }

  let timer = null
  let stopped = false

  function tick() {
    if (stopped) return
    sendTelegramChatAction(chatId, 'typing').catch(() => {})
    timer = setTimeout(tick, 4500) // refresh every 4.5s (Telegram expires at ~5s)
    timer?.unref?.()
  }

  tick() // send first indicator immediately

  return {
    stop() {
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
    },
  }
}

function collectStreamBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', c => chunks.push(c))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

/**
 * Synthesize text to speech and send as Telegram voice message.
 * Returns true if voice was sent, false to fall back to text.
 */
async function sendTelegramVoice(chatId, text) {
  const token = env('TELEGRAM_BOT_TOKEN')
  if (!token) return false
  if (!text || !text.trim()) return false
  console.log(`[Telegram] ▼ voice reply: chatId=${chatId} text="${text.slice(0, 80)}"`)

  // Synthesize speech
  const creds = getTTSCredentials()
  console.log(`[Telegram] ▼ TTS config: provider=${creds.provider} voiceId=${creds.voiceId}`)
  let buffer
  try {
    const stream = await streamTTS({
      text: text.slice(0, 2000),
      provider: creds.provider,
      voiceId: creds.voiceId,
      keys: creds,
      language: creds.aethermeshLanguage || 'zh-cn',
    })
    buffer = await collectStreamBuffer(stream)
    console.log(`[Telegram] ▼ TTS synthesized: ${(buffer.length / 1024).toFixed(1)}KB`)
    if (!buffer || buffer.length < 100) {
      console.warn(`[Telegram] ▼ TTS buffer too small, fallback to text`)
      return false
    }
  } catch (err) {
    console.warn(`[Telegram] ▼ TTS failed:`, err.message)
    return false
  }

  // Upload and send as voice message
  try {
    const fd = new FormData()
    fd.append('chat_id', String(chatId))
    fd.append('voice', buffer, { filename: 'reply.ogg', contentType: 'audio/ogg' })
    if (text.length > 100) {
      fd.append('caption', text.slice(0, 200))
    }
    console.log(`[Telegram] ▼ uploading sendVoice... (${(buffer.length / 1024).toFixed(1)}KB)`)
    const res = await multipartRequest(`https://api.telegram.org/bot${token}/sendVoice`, fd, 60000)
    console.log(`[Telegram] ▼ sendVoice result: ok=${res.ok} status=${res.status}`)
    return !!res.ok
  } catch (err) {
    console.warn(`[Telegram] ▼ sendVoice upload failed:`, err.message)
    return false
  }
}

function multipartRequest(url, fd, timeoutMs = 30000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const payload = fd.getBuffer()
    const headers = { ...fd.getHeaders(), ...extraHeaders }
    headers['Content-Length'] = payload.length
    const isHttp = parsed.protocol === 'http:'
    const mod = isHttp ? http : https
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttp ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers,
    }
    const req = mod.request(opts, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        let data = null
        try { data = text ? JSON.parse(text) : null } catch {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data, text })
      })
    })
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)) })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

export async function sendTelegramMessage(chatId, content) {
  const token = env('TELEGRAM_BOT_TOKEN')
  if (!token) return { ok: false, skipped: true, reason: 'TELEGRAM_BOT_TOKEN not configured' }

  // 嘗試從 content 中提取本地圖片，以 sendPhoto 替代 sendMessage
  const imgMatch = String(content || '').match(/!\[.*?\]\(\/media\/chat\/([^)\s]+)\)/)
  if (imgMatch) {
    const filename = imgMatch[1]
    const filePath = path.join(paths.mediaDir, path.basename(filename))
    if (fs.existsSync(filePath)) {
      const caption = content.replace(/!\[.*?\]\(\/media\/chat\/[^)\s]+\)/g, '').trim()
      // 先把文件完整讀入 Buffer，避免 form-data.getBuffer() 返回 DelayedStream
      const photoBuffer = fs.readFileSync(filePath)
      const fd = new FormData()
      fd.append('chat_id', String(chatId))
      fd.append('photo', photoBuffer, { filename: path.basename(filename) })
      if (caption) fd.append('caption', caption)
      const res = await multipartRequest(`https://api.telegram.org/bot${token}/sendPhoto`, fd)
      if (!res.ok) {
        // 降級：如果 sendPhoto 失敗，退回 sendMessage（用戶至少能看到文字）
        return sendTelegramMessage(chatId, content.replace(/!\[.*?\]\(.*?\)/g, '').trim() || '（图片）')
      }
      return { ok: true, platform: 'telegram', message_id: res.data?.result?.message_id || null }
    }
  }

  // Decide whether to reply with voice based on per-chat mode
  const mode = voiceModes.get(String(chatId)) || 'auto'
  const shouldVoice = mode === 'on' || (mode === 'auto' && voiceReplyChats.has(String(chatId)))
  if (shouldVoice) {
    voiceReplyChats.delete(String(chatId))
    const sent = await sendTelegramVoice(chatId, content)
    if (sent) return { ok: true, platform: 'telegram' }
  }

  const res = await requestJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    body: { chat_id: Number(chatId), text: content },
  })
  if (!res.ok) throw new Error(`Telegram send failed HTTP ${res.status}: ${res.text}`)
  return { ok: true, platform: 'telegram', message_id: res.data?.result?.message_id || null }
}
