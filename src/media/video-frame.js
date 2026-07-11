import { execFile, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { paths } from '../paths.js'

const FFMPEG_BIN = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const FFPROBE_BIN = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'

let _ffmpegPath = null
let _ffprobePath = null

function cacheDir() {
  return paths.binDir
}

async function findBinary(name) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await execFile(cmd, [name])
    const p = (stdout || '').trim().split('\n')[0]
    if (p && fs.existsSync(p)) return p
  } catch {}
  const cached = path.join(cacheDir(), name)
  if (fs.existsSync(cached)) return cached
  for (const dir of commonBinaryDirs()) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return p
  }
  return null
}

function commonBinaryDirs() {
  if (process.platform === 'darwin') {
    return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
  }
  if (process.platform === 'linux') {
    return ['/usr/local/bin', '/usr/bin', '/snap/bin']
  }
  return []
}

export async function findFFmpeg() {
  if (_ffmpegPath) return _ffmpegPath
  _ffmpegPath = await findBinary(FFMPEG_BIN)
  return _ffmpegPath
}

export async function findFFprobe() {
  if (_ffprobePath) return _ffprobePath
  _ffprobePath = await findBinary(FFPROBE_BIN)
  return _ffprobePath
}

export async function ensureFFmpeg() {
  const ff = await findFFmpeg()
  if (ff) return ff
  const url = downloadURL()
  if (!url) throw new Error('ffmpeg not found. Install ffmpeg (brew install ffmpeg / winget install ffmpeg)')
  console.log(`[video] downloading ffmpeg...`)
  const destDir = cacheDir()
  fs.mkdirSync(destDir, { recursive: true })
  const tmpFile = path.join(os.tmpdir(), `ffmpeg-dl-${Date.now()}`)
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(tmpFile, buf)
    fs.chmodSync(tmpFile, 0o755)
    const dest = path.join(destDir, FFMPEG_BIN)
    fs.renameSync(tmpFile, dest)
    _ffmpegPath = dest
    console.log(`[video] ffmpeg cached at ${dest}`)
    return dest
  } catch (err) {
    try { fs.unlinkSync(tmpFile) } catch {}
    throw new Error(`Failed to download ffmpeg: ${err.message}`)
  }
}

function downloadURL() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'darwin') {
    return arch === 'arm64'
      ? 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/darwin-arm64'
      : 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/darwin-x64'
  }
  if (process.platform === 'win32') {
    return 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/win32-x64'
  }
  if (process.platform === 'linux') {
    return arch === 'arm64'
      ? 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/linux-arm64'
      : 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/linux-x64'
  }
  return null
}

export async function getVideoDuration(input) {
  const bin = await ensureFFmpeg()
  if (!bin) throw new Error('ffmpeg not available')
  const tmp = Buffer.isBuffer(input) ? path.join(os.tmpdir(), `vid-dur-${Date.now()}.mp4`) : null
  const inputPath = tmp || input
  try {
    if (tmp) fs.writeFileSync(tmp, input)
    const duration = await new Promise((resolve, reject) => {
      const cp = spawn(bin, ['-i', inputPath], { timeout: 10000 })
      let done = false
      let buf = ''
      cp.stderr.on('data', d => {
        if (done) return
        buf += d.toString()
        const m = buf.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
        if (m) {
          done = true
          cp.kill()
          resolve(parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 100)
        }
      })
      cp.on('error', reject)
      cp.on('exit', () => {
        if (!done) resolve(null)
      })
    })
    return duration
  } finally {
    if (tmp) try { fs.unlinkSync(tmp) } catch {}
  }
}

function frameCountForDuration(durationSec) {
  if (durationSec <= 10) return 2
  if (durationSec <= 30) return 3
  if (durationSec <= 60) return 4
  return 6
}

async function pickKeyTimestamps(inputPath, durationSec, count, sceneThreshold = 0.3) {
  const bin = await ensureFFmpeg()
  // Scene detection pass: ffmpeg with select=gt(scene) + showinfo
  // 回傳 scene change 的時間點，如果沒場景變化則回傳空陣列。
  const out = await new Promise((resolve) => {
    const cp = spawn(bin, [
      '-i', inputPath,
      '-vf', `select='gt(scene,${sceneThreshold})',showinfo`,
      '-f', 'null',
      '-',
    ], { timeout: 120000 })
    let buf = ''
    cp.stderr.on('data', d => { buf += d.toString() })
    cp.on('exit', () => resolve(buf))
  })
  const times = []
  const re = /pts_time:([\d.]+)/g
  let m
  while ((m = re.exec(out))) times.push(parseFloat(m[1]))
  // 沒有場景變化 → 回傳空 (caller 用均勻取樣)
  if (times.length === 0) return []
  // 從場景變化點中挑 N 個（均勻子取樣）
  const picked = []
  if (times.length >= count) {
    const step = times.length / count
    for (let i = 0; i < count; i++) picked.push(times[Math.floor(i * step)])
  } else {
    picked.push(...times)
    // 不足的用均勻取樣補滿
    const used = new Set(picked.map(t => Math.round(t * 10)))
    const seg = durationSec / count
    for (let i = 0; i < count && picked.length < count; i++) {
      const t = seg * i + seg / 2
      if (!used.has(Math.round(t * 10))) {
        picked.push(t)
        used.add(Math.round(t * 10))
      }
    }
    picked.sort((a, b) => a - b)
    while (picked.length > count) picked.pop()
  }
  return picked
}

function runFFmpeg(bin, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const cp = spawn(bin, args, { timeout })
    let stderr = ''
    cp.stderr.on('data', d => { stderr += d.toString() })
    cp.on('error', reject)
    cp.on('exit', code => {
      if (code !== 0) reject(new Error(`ffmpeg exit ${code}\n${stderr.slice(-2000)}`))
      else resolve()
    })
  })
}

export async function extractVideoFrames(input, { durationSec, maxFrames, saveDir } = {}) {
  const bin = await ensureFFmpeg()
  if (!bin) throw new Error('ffmpeg not available')
  const tmp = Buffer.isBuffer(input) ? path.join(os.tmpdir(), `vid-fr-${Date.now()}.mp4`) : null
  const inputPath = tmp || input
  const outDir = saveDir || path.join(os.tmpdir(), `vid-out-${Date.now()}`)
  try {
    if (tmp) fs.writeFileSync(tmp, input)
    if (!durationSec) durationSec = await getVideoDuration(inputPath) || 30
    const count = maxFrames || frameCountForDuration(durationSec)
    const ts = Date.now()
    fs.mkdirSync(outDir, { recursive: true })

    // 場景偵測取幀：挑最高分的 N 個時間點；沒場景變化則用均勻取樣
    const keyTimes = await pickKeyTimestamps(inputPath, durationSec, count)
    const useScene = keyTimes.length > 0

    if (useScene) {
      // 逐幀用 -ss 快速 seek 取出（每個約 0.5-2s）
      for (let i = 0; i < keyTimes.length; i++) {
        const outFile = path.join(outDir, `vf-${ts}-${String(i + 1).padStart(3, '0')}.jpg`)
        await runFFmpeg(bin, [
          '-ss', String(keyTimes[i]),
          '-i', inputPath,
          '-frames:v', '1',
          '-qscale:v', '2',
          '-vf', 'scale=720:-2',
          outFile,
        ], 15000)
      }
    } else {
      // 均勻取樣（原始做法）
      const interval = Math.max(1, Math.floor(durationSec / count))
      await runFFmpeg(bin, [
        '-i', inputPath,
        '-vf', `fps=1/${interval},scale=720:-2`,
        '-qscale:v', '2',
        '-frames:v', String(count),
        path.join(outDir, `vf-${ts}-%03d.jpg`),
      ], 60000)
    }

    const files = fs.readdirSync(outDir).filter(f => f.startsWith(`vf-${ts}`) && f.endsWith('.jpg')).sort()
    const timestamps = useScene
      ? keyTimes
      : files.map((_, i) => i * Math.max(1, Math.floor(durationSec / count)))
    if (saveDir) {
      const frames = files.map((f, i) => ({
        path: `/media/chat/${f}`,
        timestamp: timestamps[i] ?? 0,
      }))
      return { frames, durationSec }
    }
    const buffers = files.map(f => fs.readFileSync(path.join(outDir, f)))
    return { frames: buffers.map((buf, i) => ({
      dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`,
      timestamp: timestamps[i] ?? 0,
    })), durationSec }
  } catch (err) {
    throw new Error(`frame extraction failed: ${err.message}`)
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
    if (!saveDir) {
      try { fs.rmSync(outDir, { recursive: true, force: true }) } catch {}
    }
  }
}

