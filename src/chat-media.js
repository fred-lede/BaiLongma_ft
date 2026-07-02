import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { paths } from './paths.js'

export const CHAT_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

const MIME_TO_EXT = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/bmp', '.bmp'],
])

const EXT_TO_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
])

function normalizeExt(ext = '', fallback = '.png') {
  const clean = String(ext || '').trim().toLowerCase()
  if (!clean) return fallback
  return clean.startsWith('.') ? clean : `.${clean}`
}

function extFromMime(mime = '', fallback = '.png') {
  return MIME_TO_EXT.get(String(mime || '').split(';')[0].trim().toLowerCase()) || fallback
}

function mimeFromExt(ext = '') {
  return EXT_TO_MIME.get(normalizeExt(ext)) || 'application/octet-stream'
}

export function persistChatMediaBuffer(buffer, { ext = '.png' } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '')
  if (!buf.length) throw new Error('media buffer is empty')
  const cleanExt = normalizeExt(ext)
  const hash = crypto.createHash('sha256').update(buf).digest('hex')
  const storedName = `${hash}${cleanExt}`
  const storedPath = path.join(paths.mediaDir, storedName)
  if (!fs.existsSync(storedPath)) fs.writeFileSync(storedPath, buf)
  return {
    url: `/media/chat/${storedName}`,
    path: storedPath,
    filename: storedName,
    mime: mimeFromExt(cleanExt),
    size: buf.length,
  }
}

export function persistChatMediaPath(filePath = '') {
  let resolved = String(filePath || '').trim()
  if (!resolved) throw new Error('media path required')
  if (/^file:\/\//i.test(resolved)) resolved = fileURLToPath(resolved)
  resolved = path.resolve(resolved)
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) throw new Error(`media path is not a file: ${resolved}`)
  return persistChatMediaBuffer(fs.readFileSync(resolved), { ext: path.extname(resolved) || '.png' })
}

export function persistChatMediaDataUrl(dataUrl = '') {
  const raw = String(dataUrl || '').trim()
  const match = raw.match(/^data:([^;,]+)(?:;[^,]*)?;base64,([a-z0-9+/=\s]+)$/i)
  if (!match) throw new Error('expected a base64 data URL')
  const mime = match[1].toLowerCase()
  if (!mime.startsWith('image/')) throw new Error(`unsupported media type: ${mime}`)
  return persistChatMediaBuffer(Buffer.from(match[2].replace(/\s+/g, ''), 'base64'), {
    ext: extFromMime(mime),
  })
}

export function markdownImage(url = '', alt = 'image') {
  const safeAlt = String(alt || 'image').replace(/[\]\r\n]/g, ' ').trim() || 'image'
  return `![${safeAlt}](${url})`
}
