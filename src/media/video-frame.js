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
    const { stdout, stderr } = await execFile(bin, [
      '-i', inputPath,
      '-f', 'null',
      '-',
    ], { timeout: 15000 })
    const match = (stdout + stderr).match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
    if (!match) return 0
    return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 100
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
    const interval = Math.max(1, Math.floor(durationSec / count))
    fs.mkdirSync(outDir, { recursive: true })
    const ts = Date.now()
    const args = [
      '-i', inputPath,
      '-vf', `fps=1/${interval},scale=720:-2`,
      '-qscale:v', '2',
      '-frames:v', String(count),
      path.join(outDir, `vf-${ts}-%03d.jpg`),
    ]
    let ffStderr = ''
    await new Promise((resolve, reject) => {
      const cp = spawn(bin, args, { timeout: 60000 })
      cp.stderr.on('data', d => { ffStderr += d.toString() })
      cp.on('error', reject)
      cp.on('exit', code => {
        if (code !== 0) reject(new Error(`ffmpeg exit ${code}\n${ffStderr.slice(-2000)}`))
        else resolve()
      })
    })
    const files = fs.readdirSync(outDir).filter(f => f.startsWith(`vf-${ts}`) && f.endsWith('.jpg')).sort()
    if (saveDir) {
      const frames = files.map((f, i) => ({
        path: `/media/chat/${f}`,
        timestamp: i * interval,
      }))
      return { frames, durationSec }
    }
    const buffers = files.map(f => fs.readFileSync(path.join(outDir, f)))
    const timestamps = buffers.map((_, i) => i * interval)
    return { frames: buffers.map((buf, i) => ({
      dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`,
      timestamp: timestamps[i],
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

