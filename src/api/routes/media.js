import fs from 'fs'
import path from 'path'
import os from 'os'
import { paths } from '../../paths.js'
import { getMediaHistory, upsertMediaHistory } from '../../db.js'
import { execGenerateVideo, getVideoHistory, saveGeneratedVideo } from '../../capabilities/tools/media.js'
import { mimeFromChatMediaExt } from '../../chat-media.js'
import { isPathInside, jsonResponse, readJsonBody } from '../utils.js'
import { extractVideoFrames } from '../../media/video-frame.js'

function streamFile(req, res, filePath, contentType, { cacheControl = 'no-cache', range = false } = {}) {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) {
      res.writeHead(404)
      res.end('media not found')
      return
    }
    const total = stat.size
    const rangeHeader = range ? req.headers.range : null
    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d*)-(\d*)/)
      const start = m?.[1] ? parseInt(m[1]) : 0
      const end = m?.[2] ? parseInt(m[2]) : total - 1
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control': cacheControl,
      })
      fs.createReadStream(filePath, { start, end }).pipe(res)
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': total,
        ...(range ? { 'Accept-Ranges': 'bytes' } : {}),
        'Cache-Control': cacheControl,
      })
      fs.createReadStream(filePath).pipe(res)
    }
  } catch {
    res.writeHead(404)
    res.end('media not found')
  }
}

function ensureInside(res, root, filePath, { allowRoot = true } = {}) {
  if (isPathInside(root, filePath) && (allowRoot || path.resolve(root) !== path.resolve(filePath))) return true
  res.writeHead(403)
  res.end('forbidden')
  return false
}

export async function handleMediaRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/media/history') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '30'), 100)
    jsonResponse(res, 200, getMediaHistory(limit))
    return true
  }

  if (req.method === 'POST' && url.pathname === '/media/history') {
    try {
      const body = await readJsonBody(req)
      if (!body.url || !body.kind) {
        jsonResponse(res, 400, { ok: false, error: 'url and kind required' })
        return true
      }
      upsertMediaHistory(body)
      jsonResponse(res, 200, { ok: true })
    } catch (e) {
      jsonResponse(res, 400, { ok: false, error: e.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/aivideo/generate') {
    try {
      const body = await readJsonBody(req, { maxBytes: 30 * 1024 * 1024 })
      const result = await execGenerateVideo({
        action: 'generate',
        prompt: body.prompt,
        images: Array.isArray(body.images) ? body.images : undefined,
        image_url: body.image_url || body.image,
        ratio: body.ratio,
        resolution: body.resolution,
        duration: body.duration,
      })
      const parsed = typeof result === 'string' ? JSON.parse(result) : result
      jsonResponse(res, parsed.ok ? 200 : 400, parsed)
    } catch (e) {
      const status = e.statusCode === 413 ? 413 : 400
      const message = e.statusCode === 413 ? 'Request body too large. Please keep images under about 18MB.' : e.message
      jsonResponse(res, status, { ok: false, error: message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/aivideo/draft') {
    try {
      const body = await readJsonBody(req, { maxBytes: 256 * 1024 })
      const { setAIVideoPanelState } = await import('../../capabilities/tools/media.js')
      setAIVideoPanelState({ open: body.open, prompt: body.prompt })
      jsonResponse(res, 200, { ok: true })
    } catch (e) {
      jsonResponse(res, e.statusCode === 413 ? 413 : 400, { ok: false, error: e.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/aivideo/save') {
    try {
      const body = await readJsonBody(req)
      const result = saveGeneratedVideo(body.jobId)
      jsonResponse(res, result.ok ? 200 : 400, result)
    } catch (e) {
      jsonResponse(res, 400, { ok: false, error: e.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/aivideo/history') {
    try {
      jsonResponse(res, 200, { ok: true, jobs: getVideoHistory() })
    } catch (e) {
      jsonResponse(res, 200, { ok: false, jobs: [], error: e.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/media/music/')) {
    const raw = url.pathname.slice('/media/music/'.length)
    const filename = path.basename(decodeURIComponent(raw))
    const filePath = path.join(paths.musicDir, filename)
    if (!ensureInside(res, paths.musicDir, filePath)) return true
    const mimeMap = {
      '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav',
      '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
      '.opus': 'audio/ogg; codecs=opus',
    }
    const contentType = mimeMap[path.extname(filename).toLowerCase()] || 'audio/mpeg'
    streamFile(req, res, filePath, contentType, { range: true })
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/media/video/')) {
    const raw = url.pathname.slice('/media/video/'.length)
    const filename = path.basename(decodeURIComponent(raw))
    const videoDir = path.join(paths.sandboxDir, 'videos')
    const filePath = path.join(videoDir, filename)
    if (!ensureInside(res, videoDir, filePath)) return true
    const mimeMap = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' }
    const contentType = mimeMap[path.extname(filename).toLowerCase()] || 'video/mp4'
    streamFile(req, res, filePath, contentType, { range: true })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/media/video/analyze') {
    try {
      const ct = req.headers['content-type'] || ''
      const boundary = ct.match(/boundary=(.+)/)?.[1]
      if (!boundary) { jsonResponse(res, 400, { ok: false, error: 'multipart boundary required' }); return true }
      const body = await new Promise((resolve, reject) => {
        const chunks = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => resolve(Buffer.concat(chunks)))
        req.on('error', reject)
      })
      const b = Buffer.from(`--${boundary}`)
      const partStart = body.indexOf(b)
      if (partStart === -1) { jsonResponse(res, 400, { ok: false, error: 'no multipart part found' }); return true }
      const afterFirstBoundary = partStart + b.length
      const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), afterFirstBoundary)
      if (headerEnd === -1) { jsonResponse(res, 400, { ok: false, error: 'malformed multipart' }); return true }
      const dataStart = headerEnd + 4
      const nextBoundary = body.indexOf(b, dataStart)
      const dataEnd = nextBoundary !== -1 ? nextBoundary - 2 : body.length - 2
      const videoBuf = body.subarray(dataStart, dataEnd)
      const { frames, durationSec } = await extractVideoFrames(videoBuf, {})
      jsonResponse(res, 200, {
        ok: true,
        frames: frames.map(f => ({ dataUrl: f.dataUrl, timestamp: f.timestamp })),
        durationSec,
      })
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/media/chat/')) {
    const raw = url.pathname.slice('/media/chat/'.length)
    const filename = path.basename(decodeURIComponent(raw))
    const mediaDir = paths.mediaDir
    const filePath = path.join(mediaDir, filename)
    if (!ensureInside(res, mediaDir, filePath, { allowRoot: false })) return true
    const contentType = mimeFromChatMediaExt(path.extname(filename).toLowerCase())
    streamFile(req, res, filePath, contentType, { cacheControl: 'public, max-age=31536000, immutable' })
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/audio/')) {
    const filename = path.basename(url.pathname)
    const filePath = path.join(paths.sandboxDir, 'audio', filename)
    streamFile(req, res, filePath, 'audio/mpeg')
    return true
  }

  return false
}
