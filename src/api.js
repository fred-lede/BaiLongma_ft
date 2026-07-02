import http from 'http'
import fs from 'fs'
import path from 'path'
import net from 'net'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import { handleSceneConnection, setSceneIntentHandler } from './scene/scene-server.js'
import { sceneStore } from './scene/scene-store.js'
import { pushMessage } from './queue.js'
import { getDB, getConfig, setConfig, insertUISignal, upsertMediaHistory, getMediaHistory, updateLastJarvisConversationContent, getRecentRecallAudits, getRecentExtractAudits, getRecallAuditStats, getExtractAuditStats } from './db.js'
import { emitEvent, addSSEClient, removeSSEClient, flushStickyEvents, setStickyEvent } from './events.js'
import { getQuotaStatus } from './quota.js'
import { isRunning, stopLoop, startLoop } from './control.js'
import { buildHeartbeatSystemPromptPreview } from './system-prompt-preview.js'
import { paths } from './paths.js'
import { config, activate as activateLLM, prepareActivation as prepareLLMActivation, commitPreparedActivation, getActivationStatus, switchModel, saveLLMSettings, setTemperature, setThinking, getMinimaxKey, setMinimaxKey, getSocialConfig, setSocialConfig, getVoiceConfig, setVoiceConfig, getTTSConfig, setTTSConfig, getTTSCredentials, getProviderSummaries, getSecurity, setSecurity, getNetworkConfig, setNetworkConfig, getEmbeddingConfig, setEmbeddingConfig, EMBEDDING_PROVIDER_PRESETS, getWebSearchConfig, setWebSearchConfig } from './config.js'
import { streamTTS, TTS_PROVIDERS, TTS_VOICES, validateTTSConfig } from './voice/tts-providers.js'
import { restartConnector } from './social/index.js'
// manager.js (Whisper local server) removed
import { replaceProvider } from './providers/registry.js'
import { execGenerateVideo, saveGeneratedVideo, setAIVideoPanelState, getVideoHistory, stripMarkdownForSpeech } from './capabilities/tools/media.js'
import { MinimaxProvider } from './providers/minimax.js'
import { handleSocialWebhook, isSocialWebhookPath } from './social/webhooks.js'
import { getClawbotQR, logoutClawbot } from './social/wechat-clawbot.js'
import { getFeishuStatus } from './social/feishu-ws.js'
import { createCloudASRSession } from './voice/cloud-asr.js'
import { getHotspots, setHotspotPanelState, getHotspotPanelState } from './hotspots.js'
import { getWorldcup, setWorldcupPanelState, getWorldcupPanelState } from './worldcup.js'
import { getPersonCard, setPersonCardPanelState, getPersonCardPanelState } from './person-cards.js'
import { setDocPanelState, getDocPanelState, DOC_TOPICS } from './docs.js'
import { getTraces, getTrace, clearTraces, getTraceStatus } from './runtime/turn-trace.js'
import { getTerminalStreamSnapshot } from './terminal-stream.js'
import { getSelfEvolutionSnapshot } from './memory/self-evolution.js'
import { markdownImage, persistChatMediaDataUrl } from './chat-media.js'

export { emitEvent }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INDEX_PATH         = paths.indexHtml
const DASHBOARD_PATH     = paths.dashboardHtml
const BRAIN_PATH         = paths.brainHtml
const BRAIN_UI_PATH      = paths.brainUiHtml
const WEBSITE_PATH       = paths.websiteHtml
const SYSTEM_PROMPT_PATH = paths.systemPromptHtml
const ACTIVATION_PATH    = paths.activationHtml
const TURN_TRACE_PATH    = paths.turnTraceHtml
const BRAIN_UI_ASSET_ROOT = paths.brainUiAssetRoot
const SCENE_SHELL_ASSET_ROOT = path.join(paths.resourcesDir, 'src', 'ui', 'scene-shell')
const TERMINAL_STREAM_PATH = path.join(paths.resourcesDir, 'src', 'ui', 'terminal-stream', 'index.html')
const D3_VENDOR_PATH     = path.join(paths.resourcesDir, 'node_modules', 'd3', 'dist', 'd3.min.js')
const SANDBOX_PATH       = paths.sandboxDir
const DEFAULT_AGENT_NAME = '小白龙'
const DEFAULT_API_HOST = '127.0.0.1'
const INBOUND_MESSAGE_DEDUPE_TTL_MS = 10_000
const INBOUND_MESSAGE_FALLBACK_DEDUPE_MS = 1_500
const MAX_INBOUND_CHAT_MEDIA = 8
const recentInboundMessages = new Map()

function pruneRecentInboundMessages(now = Date.now()) {
  for (const [key, entry] of recentInboundMessages) {
    if (!entry || now - entry.timestamp > INBOUND_MESSAGE_DEDUPE_TTL_MS) {
      recentInboundMessages.delete(key)
    }
  }
}

function normalizeClientMessageId(value = '') {
  const text = String(value || '').trim()
  return /^[a-zA-Z0-9._:-]{8,128}$/.test(text) ? text : ''
}

function claimInboundMessage({ fromId, channel, content, clientMessageId }) {
  const now = Date.now()
  pruneRecentInboundMessages(now)
  const explicitId = normalizeClientMessageId(clientMessageId)
  const key = explicitId
    ? `id:${explicitId}`
    : `body:${JSON.stringify([fromId || '', channel || '', content || ''])}`
  const existing = recentInboundMessages.get(key)
  const ttl = explicitId ? INBOUND_MESSAGE_DEDUPE_TTL_MS : INBOUND_MESSAGE_FALLBACK_DEDUPE_MS
  if (existing && now - existing.timestamp <= ttl) return { claimed: false, key }
  recentInboundMessages.set(key, { timestamp: now })
  return { claimed: true, key }
}

// card.action signals that are lifecycle/system-internal — stored in DB for passive injector use only, not pushed to the agent queue
function getApiHost() {
  const envHost = String(globalThis.process?.env?.BAILONGMA_HOST || '').trim()
  if (envHost) return envHost
  return getNetworkConfig().allowLanAccess ? '0.0.0.0' : DEFAULT_API_HOST
}

function isLanAccessEnabled() {
  return getNetworkConfig().allowLanAccess
    || /^(1|true|yes|on)$/i.test(String(globalThis.process?.env?.BAILONGMA_ALLOW_LAN || '').trim())
}

function normalizeRemoteAddress(address = '') {
  const value = String(address || '').trim().toLowerCase()
  if (value.startsWith('::ffff:')) return value.slice('::ffff:'.length)
  return value
}

function isLoopbackAddress(address = '') {
  const value = normalizeRemoteAddress(address)
  return value === '127.0.0.1'
    || value === '::1'
    || value === 'localhost'
}

function isLoopbackRequest(req) {
  return isLoopbackAddress(req.socket?.remoteAddress)
}

function isPrivateLanAddress(address = '') {
  const value = normalizeRemoteAddress(address)
  if (!value) return false

  if (net.isIP(value) === 4) {
    const [a, b] = value.split('.').map(part => Number(part))
    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
  }

  if (net.isIP(value) === 6) {
    return value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')
  }

  return false
}

function isLanRequest(req) {
  return isLanAccessEnabled() && isPrivateLanAddress(req.socket?.remoteAddress)
}

function isLoopbackOrigin(origin = '') {
  if (!origin || origin === 'null') return true
  try {
    const parsed = new URL(origin)
    return ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
  } catch {
    return false
  }
}

function isAllowedOrigin(origin = '') {
  if (isLoopbackOrigin(origin)) return true
  if (!isLanAccessEnabled()) return false
  try {
    const parsed = new URL(origin)
    return isPrivateLanAddress(parsed.hostname)
  } catch {
    return false
  }
}

function getAuthToken() {
  return String(globalThis.process?.env?.BAILONGMA_API_TOKEN || '').trim()
}

function hasValidAuthToken(req, url) {
  const expected = getAuthToken()
  if (!expected) return false
  const header = req.headers.authorization || ''
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  const queryToken = url.searchParams.get('token')
  return bearer === expected || queryToken === expected
}

function requireLocalOrToken(req, res, url) {
  if (isLoopbackRequest(req) || hasValidAuthToken(req, url)) return true
  jsonResponse(res, 403, { ok: false, error: 'forbidden' })
  return false
}

function hasAllowedAccess(req, url) {
  return isLoopbackRequest(req) || hasValidAuthToken(req, url) || isLanRequest(req)
}

function isSensitivePath(pathname) {
  return pathname === '/activate'
    || pathname === '/activate/prepare'
    || pathname === '/settings'
    || pathname.startsWith('/settings/')
    || pathname.startsWith('/admin/')
    || pathname.startsWith('/memories/')
}

function isPathInside(parentDir, candidatePath) {
  const parent = path.resolve(parentDir)
  const candidate = path.resolve(candidatePath)
  const relative = path.relative(parent, candidate)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function getRequestCharset(contentType = '') {
  const match = String(contentType || '').match(/(?:^|;)\s*charset\s*=\s*"?([^";\s]+)"?/i)
  return match?.[1]?.trim().toLowerCase() || ''
}

function decodeRequestBody(buffer, contentType = '') {
  if (!buffer || buffer.length === 0) return ''

  if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return buffer.slice(3).toString('utf8')
  }
  if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return buffer.slice(2).toString('utf16le')
  }
  if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
    try { return new TextDecoder('utf-16be').decode(buffer.slice(2)) } catch {}
  }

  const charset = getRequestCharset(contentType)
  if (charset === 'utf8' || charset === 'utf-8' || charset === '') {
    const decoded = buffer.toString('utf8')
    if (!charset && decoded.includes('\uFFFD')) {
      try {
        const fallback = new TextDecoder('gbk', { fatal: true }).decode(buffer)
        if (fallback && !fallback.includes('\uFFFD')) return fallback
      } catch {}
    }
    return decoded
  }
  if (charset === 'utf16le' || charset === 'utf-16le' || charset === 'ucs-2' || charset === 'utf16') {
    return buffer.toString('utf16le')
  }

  try {
    return new TextDecoder(charset, { fatal: true }).decode(buffer)
  } catch {
    return buffer.toString('utf8')
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try {
        const raw = decodeRequestBody(Buffer.concat(chunks), req.headers['content-type'])
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function collectInboundChatMedia(body = {}) {
  const out = []
  const push = (item, fallbackAlt = 'image') => {
    if (!item) return
    if (typeof item === 'string') {
      out.push({ dataUrl: item, alt: fallbackAlt })
      return
    }
    if (typeof item !== 'object') return
    const dataUrl = item.data_url || item.dataUrl || item.url || item.src || item.image
    if (!dataUrl) return
    out.push({
      dataUrl: String(dataUrl),
      alt: item.alt || item.name || item.filename || fallbackAlt,
    })
  }

  if (Array.isArray(body.attachments)) {
    for (const item of body.attachments) push(item, 'attachment')
  }
  if (Array.isArray(body.images)) {
    for (const item of body.images) push(item, 'image')
  }
  push(body.image_data_url || body.imageDataUrl || body.image, 'image')
  push(body.screenshot_data_url || body.screenshotDataUrl || body.screenshot, 'system screenshot')

  return out
    .filter(item => /^data:image\//i.test(String(item.dataUrl || '').trim()))
    .slice(0, MAX_INBOUND_CHAT_MEDIA)
}

function appendInboundChatMediaMarkdown(content = '', body = {}) {
  const media = []
  for (const item of collectInboundChatMedia(body)) {
    try {
      const stored = persistChatMediaDataUrl(item.dataUrl)
      media.push({
        ...stored,
        alt: item.alt || 'image',
        markdown: markdownImage(stored.url, item.alt || 'image'),
      })
    } catch (err) {
      console.warn('[message] inbound chat media ignored:', err?.message || err)
    }
  }
  if (media.length === 0) return { content, media }
  return {
    content: `${media.map(item => item.markdown).join('\n')}\n\n${content.trim()}`.trim(),
    media,
  }
}

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    default:
      return 'text/plain; charset=utf-8'
  }
}

function getAgentName() {
  return (getConfig('agent_name') || '').trim() || DEFAULT_AGENT_NAME
}

function validateAgentName(agentName) {
  const trimmedName = String(agentName || '').trim()
  if (!trimmedName) return ''
  if (trimmedName.length > 32) {
    throw new Error('AI 名字不能超过 32 个字符')
  }
  if (!/^[一-龥A-Za-z0-9 _-]+$/.test(trimmedName)) {
    throw new Error('AI 名字只允许中文、英文字母、数字、空格、下划线、短横线')
  }
  return trimmedName
}

function publicActivationInfo(info) {
  return {
    provider: info.provider,
    model: info.model,
    models: info.models,
  }
}

function safeJsonParse(value, fallback) {
  if (value === null || value === undefined) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function stripAssistantHistoryLabels(content) {
  return String(content || '')
    .trim()
    .replace(/^(?:\s*\[assistant(?:\s+to\s+[^\]\r\n]+)?(?:\s+\d{4}-\d{2}-\d{2}T[^\]\r\n]+)?\]\s*)+/giu, '')
    .trim()
}

export function startAPI(port = 3721, { getStateSnapshot = null, onActivated = null } = {}) {
  const onActivatedCallback = onActivated
  const host = getApiHost()
  let pendingActivation = null

  function storePreparedActivation({ apiKey, info }) {
    pendingActivation = {
      token: crypto.randomUUID(),
      apiKey: String(apiKey || '').trim(),
      info,
      expiresAt: Date.now() + 10 * 60 * 1000,
    }
    return pendingActivation
  }

  function getPreparedActivation(token, apiKey) {
    if (!pendingActivation) return null
    if (pendingActivation.expiresAt <= Date.now()) {
      pendingActivation = null
      return null
    }
    if (!token || pendingActivation.token !== token) return null
    if (pendingActivation.apiKey !== String(apiKey || '').trim()) return null
    return pendingActivation
  }

  // 启动时把 DB 里的当前 agent_name 写进 sticky，
  // 这样后续每个新连上的 SSE 客户端（含 brain-ui 首次加载）能立即拿到正确名字
  try {
    const storedName = (getConfig('agent_name') || '').trim()
    if (storedName) setStickyEvent('agent_name_updated', { name: storedName })
  } catch {}
  const server = http.createServer(async (req, res) => {
    const base = `http://localhost:${port}`
    const url = new URL(req.url, base)
    const origin = req.headers.origin

    // GET /social/wechat-clawbot/qr — get current QR code status and URL
    if (req.method === 'GET' && url.pathname === '/social/wechat-clawbot/qr') {
      if (!hasAllowedAccess(req, url)) return jsonResponse(res, 403, { ok: false, error: 'forbidden' })
      return jsonResponse(res, 200, { ok: true, ...getClawbotQR() })
    }

    // GET /social/feishu/status — 飞书长连接当前状态 + 是否已配置凭据（配置弹窗用）
    if (req.method === 'GET' && url.pathname === '/social/feishu/status') {
      if (!hasAllowedAccess(req, url)) return jsonResponse(res, 403, { ok: false, error: 'forbidden' })
      const configured = !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET)
      return jsonResponse(res, 200, { ok: true, status: getFeishuStatus(), configured })
    }

    // POST /social/wechat-clawbot/logout — clear credentials and disconnect
    if (req.method === 'POST' && url.pathname === '/social/wechat-clawbot/logout') {
      if (!requireLocalOrToken(req, res, url)) return
      logoutClawbot()
      emitEvent('social_status', { platform: 'wechat-clawbot', status: 'idle' })
      return jsonResponse(res, 200, { ok: true })
    }

    if (isSocialWebhookPath(url.pathname)) {
      return handleSocialWebhook(req, res, url)
    }

    if (origin && !isAllowedOrigin(origin)) {
      return jsonResponse(res, 403, { ok: false, error: 'forbidden origin' })
    }

    if (!hasAllowedAccess(req, url)) {
      return jsonResponse(res, 403, { ok: false, error: 'forbidden' })
    }

    if (isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin || 'null')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method !== 'OPTIONS' && isSensitivePath(url.pathname) && !requireLocalOrToken(req, res, url)) return

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // POST /message — send message to agent
    if (req.method === 'POST' && url.pathname === '/message') {
      let claim = null
      try {
        const body = await readJsonBody(req)
        const { from_id = 'ID:000001', content = '', channel = 'API' } = body
        const trimmed = String(content || '').trim()
        const enhanced = appendInboundChatMediaMarkdown(trimmed, body)
        const queuedContent = enhanced.content
        if (!queuedContent.trim()) return jsonResponse(res, 400, { error: 'content or image required' })
        const clientMessageId = body.client_message_id ?? body.clientMessageId ?? ''
        claim = claimInboundMessage({ fromId: from_id, channel, content: queuedContent, clientMessageId })
        if (!claim.claimed) {
          return jsonResponse(res, 200, { ok: true, duplicate: true, agent_name: getAgentName() })
        }
        const strictEvaluation = body.strict_evaluation ?? body.strictEvaluation
          ?? (String(body.evaluation_mode || body.evaluationMode || '').toLowerCase() === 'strict' ? true : undefined)
        const forbiddenTools = body.forbidden_tools ?? body.forbiddenTools
        const meta = {}
        if (strictEvaluation !== undefined) meta.strictEvaluation = strictEvaluation
        if (Array.isArray(forbiddenTools)) meta.forbiddenTools = forbiddenTools
        if (enhanced.media.length) meta.attachments = enhanced.media
        const queued = pushMessage(from_id, queuedContent, channel, meta)
        const conversationId = queued?.conversationId || 0
        emitEvent('message_in', { from_id, content: queuedContent, channel, timestamp: new Date().toISOString(), conversation_id: conversationId, attachments: enhanced.media })
        jsonResponse(res, 200, { ok: true, agent_name: getAgentName(), conversation_id: conversationId, attachments: enhanced.media })
      } catch (e) {
        if (claim?.claimed && claim.key) recentInboundMessages.delete(claim.key)
        jsonResponse(res, 400, { error: e.message })
      }
      return
    }

    // GET /events — SSE real-time event stream (outbound channel for bidirectional communication)
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(`data: ${JSON.stringify({ type: 'connected', ts: new Date().toISOString() })}\n\n`)
      flushStickyEvents(res)
      addSSEClient(res)
      const keepAlive = setInterval(() => {
        try { res.write(': ping\n\n') } catch (_) { clearInterval(keepAlive); removeSSEClient(res) }
      }, 15000)
      req.on('close', () => {
        clearInterval(keepAlive)
        removeSSEClient(res)
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/terminal-stream/history') {
      const streamId = url.searchParams.get('stream_id') || 'default'
      jsonResponse(res, 200, getTerminalStreamSnapshot(streamId))
      return
    }

    // GET /memories?limit=20&search=keyword
    if (req.method === 'GET' && url.pathname === '/memories') {
      const db = getDB()
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100)
      const search = url.searchParams.get('search')
      let rows
      if (search) {
        try {
          rows = db.prepare(`
            SELECT m.* FROM memories m
            JOIN memories_fts ON memories_fts.rowid = m.id
            WHERE memories_fts MATCH ? AND m.visibility = 1
            ORDER BY bm25(memories_fts), m.created_at DESC LIMIT ?
          `).all(search, limit)
        } catch {
          rows = db.prepare(`
            SELECT * FROM memories
            WHERE (
              title LIKE ? OR mem_id LIKE ? OR content LIKE ? OR detail LIKE ?
              OR entities LIKE ? OR concepts LIKE ? OR tags LIKE ?
            )
            AND visibility = 1
            ORDER BY created_at DESC LIMIT ?
          `).all(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, limit)
        }
      } else {
        rows = db.prepare('SELECT * FROM memories WHERE visibility = 1 ORDER BY created_at DESC LIMIT ?').all(limit)
      }
      jsonResponse(res, 200, rows)
      return
    }

    // GET /audit/recall?limit=50 — recent recall_audit rows (Memory-Optimization v0.1 Phase 0)
    if (req.method === 'GET' && url.pathname === '/audit/recall') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500)
      const rows = getRecentRecallAudits(limit).map(r => ({
        ...r,
        matched_mem_ids: safeJsonParse(r.matched_mem_ids, []),
        event_type_dist: safeJsonParse(r.event_type_dist, {}),
      }))
      jsonResponse(res, 200, rows)
      return
    }

    // GET /audit/extract?limit=50 — recent extract_audit rows
    if (req.method === 'GET' && url.pathname === '/audit/extract') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500)
      const rows = getRecentExtractAudits(limit).map(r => ({
        ...r,
        extracted_mem_ids: safeJsonParse(r.extracted_mem_ids, []),
        event_type_dist: safeJsonParse(r.event_type_dist, {}),
        skipped: !!r.skipped,
      }))
      jsonResponse(res, 200, rows)
      return
    }

    // GET /audit/stats?hours=168 — aggregate over last N hours (default 7 days)
    if (req.method === 'GET' && url.pathname === '/audit/stats') {
      const hours = Math.max(1, Math.min(parseInt(url.searchParams.get('hours') || '168'), 24 * 30))
      const sinceIso = new Date(Date.now() - hours * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
      jsonResponse(res, 200, {
        windowHours: hours,
        sinceIso,
        recall: getRecallAuditStats({ sinceIso }) || {},
        extract: getExtractAuditStats({ sinceIso }) || {},
      })
      return
    }

    // GET /turn-trace, /turn-trace.html — 回合上下文取证页（逐回合回放每轮 messages[] 与思考）
    if (req.method === 'GET' && (url.pathname === '/turn-trace' || url.pathname === '/turn-trace.html')) {
      try {
        const html = fs.readFileSync(TURN_TRACE_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('turn-trace.html not found')
      }
      return
    }

    // GET /admin/traces?limit=80 — 最近 turn 摘要列表
    if (req.method === 'GET' && url.pathname === '/admin/traces') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '80'), 80)
      jsonResponse(res, 200, { ok: true, status: getTraceStatus(), traces: getTraces(limit) })
      return
    }

    // GET /admin/traces/:id — 单个 turn 完整记录（每轮 offset + 模型输出 + 最终 messages 快照）
    if (req.method === 'GET' && url.pathname.startsWith('/admin/traces/')) {
      const id = decodeURIComponent(url.pathname.slice('/admin/traces/'.length))
      const trace = getTrace(id)
      if (!trace) return jsonResponse(res, 404, { ok: false, error: 'trace not found' })
      jsonResponse(res, 200, { ok: true, trace })
      return
    }

    // POST /admin/traces-clear — 清空所有追踪记录（含落盘文件）
    if (req.method === 'POST' && url.pathname === '/admin/traces-clear') {
      jsonResponse(res, 200, clearTraces())
      return
    }

    // GET /conversations?limit=60 — chat history (ascending by time, most recent last)
    // Internal SYSTEM/APP_SIGNAL rows are hidden by default so UI-only signals
    // do not render as chat bubbles. Use includeSystemSignals=true for debugging.
    // The absorbed flag (dynamic memory pool 3.5) only filters main-line injection
    // in injector.js; here the operator needs to see everything for debugging.
    if (req.method === 'GET' && url.pathname === '/conversations') {
      const db = getDB()
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '60'), 500)
      const includeSystemSignals = url.searchParams.get('includeSystemSignals') === 'true'
      const rows = db.prepare(`
        SELECT id, role, from_id, to_id, content, timestamp, channel, external_party_id, focus_absorbed, focus_topic, open_question
        FROM conversations
        WHERE (? OR NOT (from_id = 'SYSTEM' AND channel = 'APP_SIGNAL'))
        ORDER BY id DESC
        LIMIT ?
      `).all(includeSystemSignals ? 1 : 0, limit)
      jsonResponse(res, 200, rows.reverse().map(row => (
        row.role === 'jarvis'
          ? { ...row, content: stripAssistantHistoryLabels(row.content) }
          : row
      )))
      return
    }

    // GET /status
    if (req.method === 'GET' && url.pathname === '/status') {
      const db = getDB()
      const { n } = db.prepare('SELECT COUNT(*) as n FROM memories').get()
      jsonResponse(res, 200, {
        ok: true,
        memory_count: n,
        running: isRunning(),
        self_evolution: getSelfEvolutionSnapshot({ maxRecent: 5 }),
      })
      return
    }

    // GET /self-evolution — recent memory-backed behavior improvements
    if (req.method === 'GET' && (url.pathname === '/self-evolution' || url.pathname === '/memory/self-evolution')) {
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '20'), 24))
      jsonResponse(res, 200, { ok: true, ...getSelfEvolutionSnapshot({ maxRecent: limit }) })
      return
    }

    // GET /quota
    if (req.method === 'GET' && url.pathname === '/quota') {
      jsonResponse(res, 200, getQuotaStatus())
      return
    }

    // GET /hotspots — unified trending data, 30-minute cache by default
    if (req.method === 'GET' && url.pathname === '/hotspots') {
      getHotspots({
        force: /^(1|true|yes)$/i.test(url.searchParams.get('refresh') || ''),
        viewed: /^(1|true|yes)$/i.test(url.searchParams.get('viewed') || ''),
      })
        .then((hotspots) => jsonResponse(res, 200, hotspots))
        .catch((err) => jsonResponse(res, 502, {
          ok: false,
          error: err.message,
          refreshMinutes: 30,
          platforms: {},
        }))
      return
    }

    if (url.pathname === '/hotspot-state') {
      if (req.method === 'GET') {
        jsonResponse(res, 200, { ok: true, state: getHotspotPanelState() })
        return
      }
      if (req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            const active = typeof body.active === 'boolean'
              ? body.active
              : /^(1|true|yes|open|show)$/i.test(String(body.active || ''))
            const state = setHotspotPanelState({ active, source: body.source || 'brain-ui' })
            jsonResponse(res, 200, { ok: true, state })
          })
          .catch((err) => jsonResponse(res, 400, { ok: false, error: err.message }))
        return
      }
    }

    // GET /worldcup — World Cup schedule/scores/standings (zhibo8, live-aware cache)
    if (req.method === 'GET' && url.pathname === '/worldcup') {
      getWorldcup({
        force: /^(1|true|yes)$/i.test(url.searchParams.get('refresh') || ''),
        viewed: /^(1|true|yes)$/i.test(url.searchParams.get('viewed') || ''),
      })
        .then((worldcup) => jsonResponse(res, 200, worldcup))
        .catch((err) => jsonResponse(res, 502, {
          ok: false,
          error: err.message,
          matches: [],
          standings: {},
        }))
      return
    }

    if (url.pathname === '/worldcup-state') {
      if (req.method === 'GET') {
        jsonResponse(res, 200, { ok: true, state: getWorldcupPanelState() })
        return
      }
      if (req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            const active = typeof body.active === 'boolean'
              ? body.active
              : /^(1|true|yes|open|show)$/i.test(String(body.active || ''))
            const state = setWorldcupPanelState({ active, source: body.source || 'brain-ui' })
            jsonResponse(res, 200, { ok: true, state })
          })
          .catch((err) => jsonResponse(res, 400, { ok: false, error: err.message }))
        return
      }
    }

    // GET /doc-panel-state — document panel state
    // POST /doc-panel-state — set document panel state { active, topicId, source }
    if (url.pathname === '/doc-panel-state') {
      if (req.method === 'GET') {
        jsonResponse(res, 200, { ok: true, state: getDocPanelState() })
        return
      }
      if (req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            const active = typeof body.active === 'boolean'
              ? body.active
              : /^(1|true|yes|open|show)$/i.test(String(body.active || ''))
            const state = setDocPanelState({ active, topicId: body.topicId || null, source: body.source || 'brain-ui' })
            jsonResponse(res, 200, { ok: true, state })
          })
          .catch((err) => jsonResponse(res, 400, { ok: false, error: err.message }))
        return
      }
    }

    // GET /docs/:topicId — get content for a specific document topic
    if (req.method === 'GET' && url.pathname.startsWith('/docs/')) {
      const topicId = url.pathname.slice(6)
      const doc = DOC_TOPICS[topicId]
      if (!doc) {
        jsonResponse(res, 404, { ok: false, error: `unknown topic: ${topicId}` })
        return
      }
      jsonResponse(res, 200, { ok: true, doc })
      return
    }

    // GET /docs — list all document topics
    if (req.method === 'GET' && url.pathname === '/docs') {
      const topics = Object.values(DOC_TOPICS).map(({ id, title, subtitle, icon, summary }) => ({ id, title, subtitle, icon, summary }))
      jsonResponse(res, 200, { ok: true, topics })
      return
    }

    if (req.method === 'GET' && url.pathname === '/person-card') {
      const name = url.searchParams.get('name') || url.searchParams.get('q') || ''
      jsonResponse(res, 200, { ok: true, card: getPersonCard(name) })
      return
    }

    if (url.pathname === '/person-card-state') {
      if (req.method === 'GET') {
        jsonResponse(res, 200, { ok: true, state: getPersonCardPanelState() })
        return
      }
      if (req.method === 'POST') {
        readJsonBody(req)
          .then((body) => {
            const active = typeof body.active === 'boolean'
              ? body.active
              : /^(1|true|yes|open|show)$/i.test(String(body.active || ''))
            const state = setPersonCardPanelState({
              active,
              source: body.source || 'brain-ui',
              card: body.card || null,
              name: body.name || '',
            })
            jsonResponse(res, 200, { ok: true, state })
          })
          .catch((err) => jsonResponse(res, 400, { ok: false, error: err.message }))
        return
      }
    }

    if (req.method === 'GET' && url.pathname === '/system-prompt-preview') {
      Promise.resolve()
        .then(() => buildHeartbeatSystemPromptPreview({
          stateSnapshot: typeof getStateSnapshot === 'function' ? getStateSnapshot() : {},
        }))
        .then((preview) => jsonResponse(res, 200, preview))
        .catch((err) => jsonResponse(res, 500, { error: err.message }))
      return
    }

    if (req.method === 'GET' && url.pathname === '/agent-profile') {
      jsonResponse(res, 200, { name: getAgentName() })
      return
    }

    // GET /media/history?limit=30
    if (req.method === 'GET' && url.pathname === '/media/history') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '30'), 100)
      jsonResponse(res, 200, getMediaHistory(limit))
      return
    }

    // POST /media/history — { kind, url, title, videoId, platform }
    if (req.method === 'POST' && url.pathname === '/media/history') {
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString())
          if (!body.url || !body.kind) return jsonResponse(res, 400, { ok: false, error: 'url and kind required' })
          upsertMediaHistory(body)
          jsonResponse(res, 200, { ok: true })
        } catch (e) {
          jsonResponse(res, 400, { ok: false, error: e.message })
        }
      })
      return
    }

    // POST /aivideo/generate — 面板内“生成”按钮直连后端，绕开 LLM。
    // body: { prompt, images?[url1,url2](data:base64/http；1 张=图生、2 张=首尾帧), image_url?(单图兼容), ratio?, resolution?, duration? }
    // execGenerateVideo 会 emit aivideo_mode 事件并后台轮询，面板自行更新。
    if (req.method === 'POST' && url.pathname === '/aivideo/generate') {
      const chunks = []
      let size = 0
      let responded = false
      const respond = (code, payload) => { if (responded) return; responded = true; jsonResponse(res, code, payload) }
      req.on('data', c => {
        size += c.length
        if (size > 30 * 1024 * 1024) {  // 30MB 上限（含 base64 图片）
          respond(413, { ok: false, error: '请求体过大（图片请控制在约 18MB 以内）' })
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', async () => {
        if (responded) return
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
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
          respond(parsed.ok ? 200 : 400, parsed)
        } catch (e) {
          respond(400, { ok: false, error: e.message })
        }
      })
      req.on('error', () => respond(400, { ok: false, error: 'request error' }))
      return
    }

    // POST /aivideo/draft — 面板把当前「开关状态 + 提示词草稿」实时同步给后端（感知通道）。
    // 后端只存内存状态，供注入器每轮贴进 agent 上下文。极轻量、不落库。
    if (req.method === 'POST' && url.pathname === '/aivideo/draft') {
      const chunks = []
      let size = 0
      req.on('data', c => {
        size += c.length
        if (size > 256 * 1024) { req.destroy(); return }  // 草稿是纯文本，256KB 足够
        chunks.push(c)
      })
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
          setAIVideoPanelState({ open: body.open, prompt: body.prompt })
          jsonResponse(res, 200, { ok: true })
        } catch (e) {
          jsonResponse(res, 400, { ok: false, error: e.message })
        }
      })
      req.on('error', () => { try { jsonResponse(res, 400, { ok: false, error: 'request error' }) } catch {} })
      return
    }

    // POST /aivideo/save — 把生成的视频复制到「下载\AI视频生成保存的视频\日期\」
    if (req.method === 'POST' && url.pathname === '/aivideo/save') {
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
          const result = saveGeneratedVideo(body.jobId)
          jsonResponse(res, result.ok ? 200 : 400, result)
        } catch (e) {
          jsonResponse(res, 400, { ok: false, error: e.message })
        }
      })
      return
    }

    // GET /aivideo/history — 面板打开时拉取已完成视频历史，重建生成栏队列（修复关闭重开后历史丢失）
    if (req.method === 'GET' && url.pathname === '/aivideo/history') {
      try {
        jsonResponse(res, 200, { ok: true, jobs: getVideoHistory() })
      } catch (e) {
        jsonResponse(res, 200, { ok: false, jobs: [], error: e.message })
      }
      return
    }

    // GET /favicon.ico ? silence the browser's automatic favicon request
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }

    // DELETE /memories/:id — delete a memory
    if (req.method === 'DELETE' && url.pathname.startsWith('/memories/')) {
      const id = parseInt(url.pathname.split('/')[2])
      if (!id) return jsonResponse(res, 400, { error: 'invalid id' })
      const db = getDB()
      db.prepare('DELETE FROM memories WHERE id = ?').run(id)
      jsonResponse(res, 200, { ok: true })
      return
    }

    // PATCH /memories/:id — update memory content/detail
    if (req.method === 'PATCH' && url.pathname.startsWith('/memories/')) {
      const id = parseInt(url.pathname.split('/')[2])
      if (!id) return jsonResponse(res, 400, { error: 'invalid id' })
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const { content, detail } = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
          const db = getDB()
          if (content !== undefined) db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(content, id)
          if (detail !== undefined) db.prepare('UPDATE memories SET detail = ? WHERE id = ?').run(detail, id)
          jsonResponse(res, 200, { ok: true })
        } catch (e) {
          jsonResponse(res, 400, { error: e.message })
        }
      })
      return
    }

    // GET /media/music/:filename — serve musicDir audio files (avoids file:// cross-origin restriction)
    if (req.method === 'GET' && url.pathname.startsWith('/media/music/')) {
      const raw = url.pathname.slice('/media/music/'.length)
      const filename = path.basename(decodeURIComponent(raw))
      const filePath = path.join(paths.musicDir, filename)
      const resolvedFile = path.resolve(filePath)
      const resolvedDir  = path.resolve(paths.musicDir)
      if (!resolvedFile.startsWith(resolvedDir + path.sep) && resolvedFile !== resolvedDir) {
        res.writeHead(403); res.end('forbidden'); return
      }
      const mimeMap = {
        '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav',
        '.aac': 'audio/aac',  '.ogg': 'audio/ogg',   '.m4a': 'audio/mp4',
        '.opus': 'audio/ogg; codecs=opus',
      }
      const contentType = mimeMap[path.extname(filename).toLowerCase()] || 'audio/mpeg'
      try {
        const stat = fs.statSync(filePath)
        const total = stat.size
        const rangeHeader = req.headers.range
        if (rangeHeader) {
          const m = rangeHeader.match(/bytes=(\d*)-(\d*)/)
          const start = m[1] ? parseInt(m[1]) : 0
          const end   = m[2] ? parseInt(m[2]) : total - 1
          res.writeHead(206, {
            'Content-Type': contentType,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Cache-Control': 'no-cache',
          })
          fs.createReadStream(filePath, { start, end }).pipe(res)
        } else {
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': total,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
          })
          fs.createReadStream(filePath).pipe(res)
        }
      } catch {
        res.writeHead(404); res.end('music file not found')
      }
      return
    }

    // GET /media/video/:filename — serve AI-generated video files from sandbox/videos (range-enabled)
    if (req.method === 'GET' && url.pathname.startsWith('/media/video/')) {
      const raw = url.pathname.slice('/media/video/'.length)
      const filename = path.basename(decodeURIComponent(raw))
      const videoDir = path.join(SANDBOX_PATH, 'videos')
      const filePath = path.join(videoDir, filename)
      const resolvedFile = path.resolve(filePath)
      const resolvedDir  = path.resolve(videoDir)
      if (!resolvedFile.startsWith(resolvedDir + path.sep) && resolvedFile !== resolvedDir) {
        res.writeHead(403); res.end('forbidden'); return
      }
      const mimeMap = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' }
      const contentType = mimeMap[path.extname(filename).toLowerCase()] || 'video/mp4'
      try {
        const stat = fs.statSync(filePath)
        const total = stat.size
        const rangeHeader = req.headers.range
        if (rangeHeader) {
          const m = rangeHeader.match(/bytes=(\d*)-(\d*)/)
          const start = m[1] ? parseInt(m[1]) : 0
          const end   = m[2] ? parseInt(m[2]) : total - 1
          res.writeHead(206, {
            'Content-Type': contentType,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Cache-Control': 'no-cache',
          })
          fs.createReadStream(filePath, { start, end }).pipe(res)
        } else {
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': total,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
          })
          fs.createReadStream(filePath).pipe(res)
        }
      } catch {
        res.writeHead(404); res.end('video file not found')
      }
      return
    }

    // GET /media/chat/:filename — serve content-addressed chat media from data/media
    //   收发消息时把图片/媒体按 sha256 落到 paths.mediaDir，这里按文件名回读。
    //   文件名即 <sha256>.<ext>，basename 已去掉任何路径分隔；再做一次目录逃逸校验兜底。
    if (req.method === 'GET' && url.pathname.startsWith('/media/chat/')) {
      const raw = url.pathname.slice('/media/chat/'.length)
      const filename = path.basename(decodeURIComponent(raw))
      const mediaDir = paths.mediaDir
      const filePath = path.join(mediaDir, filename)
      const resolvedFile = path.resolve(filePath)
      const resolvedDir  = path.resolve(mediaDir)
      if (!resolvedFile.startsWith(resolvedDir + path.sep)) {
        res.writeHead(403); res.end('forbidden'); return
      }
      const mimeMap = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
      }
      const contentType = mimeMap[path.extname(filename).toLowerCase()] || 'application/octet-stream'
      try {
        const stat = fs.statSync(filePath)
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': stat.size,
          // 内容寻址：同名文件内容永不改变，可长缓存。
          'Cache-Control': 'public, max-age=31536000, immutable',
        })
        fs.createReadStream(filePath).pipe(res)
      } catch {
        res.writeHead(404); res.end('media not found')
      }
      return
    }

    // GET /audio/:filename — serve sandbox audio files
    if (req.method === 'GET' && url.pathname.startsWith('/audio/')) {
      const filename = path.basename(url.pathname)
      const filePath = path.join(SANDBOX_PATH, 'audio', filename)
      try {
        const stat = fs.statSync(filePath)
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache',
        })
        fs.createReadStream(filePath).pipe(res)
      } catch {
        res.writeHead(404)
        res.end('audio not found')
      }
      return
    }

    // GET /activation-status — check whether the system is activated
    if (req.method === 'GET' && url.pathname === '/activation-status') {
      jsonResponse(res, 200, getActivationStatus())
      return
    }

    // POST /activate/prepare — validate and cache activation without entering the app
    if (req.method === 'POST' && url.pathname === '/activate/prepare') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', async () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8')
          const { apiKey, model, provider, baseURL } = JSON.parse(body || '{}')
          const info = await prepareLLMActivation({ provider, apiKey, model, baseURL })
          const pending = storePreparedActivation({ apiKey, info })
          jsonResponse(res, 200, {
            ok: true,
            token: pending.token,
            ...publicActivationInfo(info),
            agent_name: getAgentName(),
            expiresAt: pending.expiresAt,
          })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // POST /activate — submit API key to complete activation
    if (req.method === 'POST' && url.pathname === '/activate') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', async () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8')
          const { apiKey, model, provider, baseURL, agentName, preparedToken } = JSON.parse(body || '{}')

          const trimmedName = validateAgentName(agentName)

          const prepared = getPreparedActivation(preparedToken, apiKey)
          const info = prepared
            ? commitPreparedActivation(prepared.info)
            : await activateLLM({ provider, apiKey, model, baseURL })
          if (prepared) pendingActivation = null

          if (trimmedName) {
            try {
              setConfig('agent_name', trimmedName)
              setStickyEvent('agent_name_updated', { name: trimmedName })
              emitEvent('agent_name_updated', { name: trimmedName })
            } catch (err) {
              console.error('[API] save agent_name failed:', err)
            }
          }

          emitEvent('activated', info)
          // Notify index.js to start the main loop
          if (typeof onActivatedCallback === 'function') {
            try { onActivatedCallback() } catch (err) { console.error('[API] onActivated callback error:', err) }
          }
          jsonResponse(res, 200, { ok: true, ...info, agent_name: getAgentName() })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // GET /settings — return current LLM + MiniMax configuration status
    if (req.method === 'GET' && url.pathname === '/settings') {
      const status = getActivationStatus()
      const minimaxKey = getMinimaxKey()
      jsonResponse(res, 200, {
        agent_name: getAgentName(),
        llm: {
          activated: status.activated,
          provider: status.provider,
          model: status.model,
          baseURL: status.baseURL,
          models: status.models,
          temperature: config.temperature,
          thinking: config.thinking === true,
          apiKey: config.apiKey || '',
        },
        providers: getProviderSummaries(),
        minimax: {
          configured: !!(globalThis.process?.env?.MINIMAX_API_KEY || minimaxKey),
        },
        network: getNetworkConfig(),
      })
      return
    }

    // POST /settings/agent-name — update the persisted display name
    if (req.method === 'POST' && url.pathname === '/settings/agent-name') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const { agentName, agent_name } = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          const trimmedName = validateAgentName(agentName ?? agent_name)
          if (trimmedName) setConfig('agent_name', trimmedName)
          const name = getAgentName()
          setStickyEvent('agent_name_updated', { name })
          emitEvent('agent_name_updated', { name })
          jsonResponse(res, 200, { ok: true, agent_name: name })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // POST /settings/model — switch model only (no need to re-enter the key)
    if (req.method === 'POST' && url.pathname === '/settings/model') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', async () => {
        try {
          const { provider, apiKey, model, baseURL } = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          const result = provider || apiKey || baseURL
            ? await saveLLMSettings({ provider, apiKey, model, baseURL })
            : switchModel(model)
          emitEvent('model_switched', result)
          jsonResponse(res, 200, { ok: true, ...result })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // POST /settings/temperature — set LLM temperature
    if (req.method === 'POST' && url.pathname === '/settings/temperature') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const { temperature } = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          const result = setTemperature(temperature)
          jsonResponse(res, 200, { ok: true, ...result })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // POST /settings/thinking — toggle the model's thinking (reasoning) mode
    if (req.method === 'POST' && url.pathname === '/settings/thinking') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const { thinking } = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          const result = setThinking(thinking)
          jsonResponse(res, 200, { ok: true, ...result })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // GET /settings/security — read security sandbox configuration
    if (req.method === 'GET' && url.pathname === '/settings/security') {
      if (!hasAllowedAccess(req, url)) return jsonResponse(res, 403, { ok: false, error: 'forbidden' })
      jsonResponse(res, 200, { ok: true, security: getSecurity(), network: getNetworkConfig() })
      return
    }

    // POST /settings/security — save security sandbox configuration
    if (req.method === 'POST' && url.pathname === '/settings/security') {
      if (!requireLocalOrToken(req, res, url)) return
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const updates = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          const result = setSecurity(updates)
          const network = Object.prototype.hasOwnProperty.call(updates, 'allowLanAccess')
            ? setNetworkConfig({ allowLanAccess: !!updates.allowLanAccess })
            : getNetworkConfig()
          jsonResponse(res, 200, { ok: true, security: result, network })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // GET /settings/social — read per-platform configuration status (plaintext keys not returned)
    if (req.method === 'GET' && url.pathname === '/settings/social') {
      jsonResponse(res, 200, { ok: true, social: getSocialConfig() })
      return
    }

    // POST /settings/social — save platform credentials and hot-restart affected connectors
    if (req.method === 'POST' && url.pathname === '/settings/social') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', async () => {
        try {
          const updates = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          // 飞书凭据是否「真的变了」——必须在 setSocialConfig 覆盖 env 之前快照旧值。
          // 用户在弹窗里反复点「连接」会用相同凭据多次 POST；飞书长连接是 cluster 模式，
          // 每次重启都 close 旧连接再开新连接，连发会抖、入站消息可能投到正被顶掉的连接上。
          // 因此飞书只在凭据确实变化时才重启（与 discord 的 truthy 重启分开处理）。
          const feishuTouched = ('FEISHU_APP_ID' in updates) || ('FEISHU_APP_SECRET' in updates)
          const feishuChanged = feishuTouched && (
            (updates.FEISHU_APP_ID || '') !== (process.env.FEISHU_APP_ID || '') ||
            (updates.FEISHU_APP_SECRET || '') !== (process.env.FEISHU_APP_SECRET || '')
          )
          setSocialConfig(updates)
          // Restart the connector for each platform whose key was updated
          const PLATFORM_KEYS = {
            discord: ['DISCORD_BOT_TOKEN'],
          }
          for (const [platform, keys] of Object.entries(PLATFORM_KEYS)) {
            if (keys.some(k => updates[k])) {
              restartConnector(platform, { pushMessage, emitEvent }).catch(err =>
                console.warn(`[social] restart ${platform} failed:`, err.message)
              )
            }
          }
          // 飞书：仅在凭据变化且配齐时重启（去抖，见上方快照）。断开走下方 _feishu_disconnect。
          if (feishuChanged && process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
            restartConnector('feishu', { pushMessage, emitEvent }).catch(err =>
              console.warn('[social] restart feishu failed:', err.message)
            )
          }
          // Restart the ClawBot connector when the user clicks "Connect WeChat"
          if (updates._clawbot_connect) {
            restartConnector('wechat-clawbot', { pushMessage, emitEvent }).catch(err =>
              console.warn('[social] restart wechat-clawbot failed:', err.message)
            )
          }
          // 断开飞书：清空凭据是 falsy，不会命中上面 PLATFORM_KEYS 的 truthy 重启，
          // 需显式重启 —— 新连接器读不到凭据即返回 null，状态归 idle、旧长连接被 close。
          if (updates._feishu_disconnect) {
            restartConnector('feishu', { pushMessage, emitEvent }).catch(err =>
              console.warn('[social] restart feishu failed:', err.message)
            )
          }
          jsonResponse(res, 200, { ok: true, social: getSocialConfig() })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // POST /settings/minimax — set MiniMax API key
    if (req.method === 'POST' && url.pathname === '/settings/minimax') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const { apiKey } = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          const trimmed = String(apiKey || '').trim()
          if (!trimmed) throw new Error('API key cannot be empty')
          setMinimaxKey(trimmed)
          replaceProvider(new MinimaxProvider({ apiKey: trimmed }))
          jsonResponse(res, 200, { ok: true, configured: true })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // GET /activation — activation guide page
    if (req.method === 'GET' && (url.pathname === '/activation' || url.pathname === '/activation.html')) {
      try {
        const html = fs.readFileSync(ACTIVATION_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('activation.html not found')
      }
      return
    }

    // GET / — redirect to activation page if not activated, brain-ui if activated
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (config.needsActivation) {
        res.writeHead(302, { Location: '/activation' })
        res.end()
        return
      }
      try {
        const html = fs.readFileSync(INDEX_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        // No index.html — go directly to brain-ui
        res.writeHead(302, { Location: '/brain-ui' })
        res.end()
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/dashboard.html') {
      try {
        const html = fs.readFileSync(DASHBOARD_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('dashboard.html not found')
      }
      return
    }

    // GET /brain.html — Brain Monitor
    if (req.method === 'GET' && url.pathname === '/brain.html') {
      try {
        const html = fs.readFileSync(BRAIN_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('brain.html not found')
      }
      return
    }

    // GET /brain-ui — Brain UI (memory graph + thought stream + chat)
    if (req.method === 'GET' && (url.pathname === '/site' || url.pathname === '/site.html')) {
      try {
        const html = fs.readFileSync(WEBSITE_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('website.html not found')
      }
      return
    }

    if (req.method === 'GET' && (url.pathname === '/brain-ui' || url.pathname === '/brain-ui.html')) {
      if (config.needsActivation) {
        res.writeHead(302, { Location: '/activation' })
        res.end()
        return
      }
      try {
        const html = fs.readFileSync(BRAIN_UI_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('brain-ui.html not found')
      }
      return
    }

    if (req.method === 'GET' && (url.pathname === '/terminal-stream' || url.pathname === '/terminal-stream.html')) {
      try {
        const html = fs.readFileSync(TERMINAL_STREAM_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('terminal-stream.html not found')
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/systemPrompt.html') {
      try {
        const html = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('systemPrompt.html not found')
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/vendor/d3/d3.min.js') {
      try {
        const stat = fs.statSync(D3_VENDOR_PATH)
        res.writeHead(200, {
          'Content-Type': contentTypeFor(D3_VENDOR_PATH),
          'Content-Length': stat.size,
          'Cache-Control': 'public, max-age=31536000, immutable',
        })
        fs.createReadStream(D3_VENDOR_PATH).pipe(res)
      } catch {
        res.writeHead(404)
        res.end('d3.min.js not found')
      }
      return
    }

    // Scene 架构 shell 的静态资源(新 Agent-UI,与 brain-ui 并行)
    if (req.method === 'GET' && url.pathname.startsWith('/src/ui/scene-shell/')) {
      const relativePath = decodeURIComponent(url.pathname.slice('/src/ui/scene-shell/'.length))
      const assetRoot = path.resolve(SCENE_SHELL_ASSET_ROOT)
      const assetPath = path.resolve(SCENE_SHELL_ASSET_ROOT, relativePath)

      if (!isPathInside(assetRoot, assetPath)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }

      try {
        const stat = fs.statSync(assetPath)
        if (!stat.isFile()) {
          res.writeHead(404)
          res.end('asset not found')
          return
        }
        res.writeHead(200, {
          'Content-Type': contentTypeFor(assetPath),
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache',
        })
        fs.createReadStream(assetPath).pipe(res)
      } catch {
        res.writeHead(404)
        res.end('asset not found')
      }
      return
    }

    if (req.method === 'GET' && url.pathname.startsWith('/src/ui/brain-ui/')) {
      const relativePath = decodeURIComponent(url.pathname.slice('/src/ui/brain-ui/'.length))
      const assetRoot = path.resolve(BRAIN_UI_ASSET_ROOT)
      const assetPath = path.resolve(BRAIN_UI_ASSET_ROOT, relativePath)

      if (!isPathInside(assetRoot, assetPath)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }

      try {
        const stat = fs.statSync(assetPath)
        if (!stat.isFile()) {
          res.writeHead(404)
          res.end('asset not found')
          return
        }

        res.writeHead(200, {
          'Content-Type': contentTypeFor(assetPath),
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache',
        })
        fs.createReadStream(assetPath).pipe(res)
      } catch {
        res.writeHead(404)
        res.end('asset not found')
      }
      return
    }

    // POST /admin/stop — pause the consciousness loop (keep HTTP service running)
    if (req.method === 'POST' && url.pathname === '/admin/stop') {
      stopLoop()
      emitEvent('admin', { action: 'stop', running: false })
      jsonResponse(res, 200, { ok: true, running: false })
      return
    }

    // POST /admin/start — resume the consciousness loop
    if (req.method === 'POST' && url.pathname === '/admin/start') {
      startLoop()
      emitEvent('admin', { action: 'start', running: true })
      jsonResponse(res, 200, { ok: true, running: true })
      return
    }

    // POST /admin/restart — request a normal Electron relaunch when available.
    if (req.method === 'POST' && url.pathname === '/admin/restart') {
      jsonResponse(res, 200, { ok: true, message: 'Restarting…' })
      setTimeout(() => {
        const restart = globalThis.bailongmaAppControl?.restart
        if (typeof restart === 'function') {
          restart()
          return
        }
        process.exit(0)
      }, 500)
      return
    }

    // POST /admin/reset-memories — clear all memories and conversations
    if (req.method === 'POST' && url.pathname === '/admin/reset-memories') {
      const db = getDB()
      db.prepare('DELETE FROM memories').run()
      db.prepare('DELETE FROM conversations').run()
      db.prepare("DELETE FROM config WHERE key != 'birth_time'").run()
      db.prepare('DELETE FROM entities').run()
      db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
      emitEvent('admin', { action: 'reset-memories' })
      jsonResponse(res, 200, { ok: true })
      return
    }

    // POST /admin/reset-files — clear sandbox user files (keeping readme.txt and world.txt)
    if (req.method === 'POST' && url.pathname === '/admin/reset-files') {
      const sandboxPath = SANDBOX_PATH
      const KEEP = new Set(['readme.txt', 'world.txt'])
      function clearDir(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            clearDir(full)
            try { fs.rmdirSync(full) } catch (_) {}
          } else if (!KEEP.has(entry.name.toLowerCase())) {
            fs.unlinkSync(full)
          }
        }
      }
      try { clearDir(sandboxPath) } catch (_) {}
      emitEvent('admin', { action: 'reset-files' })
      jsonResponse(res, 200, { ok: true })
      return
    }

    // GET /settings/voice — read voice configuration (credentials returned as configured-status only)
    if (req.method === 'GET' && url.pathname === '/settings/voice') {
      jsonResponse(res, 200, { ok: true, voice: getVoiceConfig() })
      return
    }

    // POST /settings/voice — save voice configuration { whisperModel?, aliyunApiKey?, ... }
    if (req.method === 'POST' && url.pathname === '/settings/voice') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          setVoiceConfig(body)
          jsonResponse(res, 200, { ok: true, voice: getVoiceConfig() })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // GET /settings/tts — read TTS configuration status (plaintext keys not returned)
    if (req.method === 'GET' && url.pathname === '/settings/tts') {
      jsonResponse(res, 200, { ok: true, tts: getTTSConfig(), providers: TTS_PROVIDERS, voices: TTS_VOICES })
      return
    }

    // POST /settings/tts — save TTS configuration
    if (req.method === 'POST' && url.pathname === '/settings/tts') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          setTTSConfig(body)
          jsonResponse(res, 200, { ok: true, tts: getTTSConfig() })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // GET /settings/web-search — read web search configuration (plaintext keys not returned)
    if (req.method === 'GET' && url.pathname === '/settings/web-search') {
      jsonResponse(res, 200, { ok: true, webSearch: getWebSearchConfig() })
      return
    }

    // POST /settings/web-search — save web search configuration
    if (req.method === 'POST' && url.pathname === '/settings/web-search') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          setWebSearchConfig(body)
          jsonResponse(res, 200, { ok: true, webSearch: getWebSearchConfig() })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // GET /settings/embedding — read embedding configuration status (plaintext apiKey not returned)
    if (req.method === 'GET' && url.pathname === '/settings/embedding') {
      jsonResponse(res, 200, {
        ok: true,
        embedding: getEmbeddingConfig(),
        presets: EMBEDDING_PROVIDER_PRESETS,
      })
      return
    }

    // POST /settings/embedding — save embedding configuration
    if (req.method === 'POST' && url.pathname === '/settings/embedding') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
        setEmbeddingConfig(body)
        // 写入配置后清掉 embedding 模块的 LRU 缓存（key 是 sha256(text+model)，model 变了旧缓存无效）
        try {
          const { clearEmbeddingCache } = await import('./embedding.js')
          clearEmbeddingCache()
        } catch {}
        // 切到 local：后台 fire-and-forget 预热（含首次模型下载），不阻塞响应
        try {
          const { getEmbeddingCredentials } = await import('./config.js')
          const cred = getEmbeddingCredentials()
          if (cred?.provider === 'local' && cred.model) {
            const { warmupLocalEmbedding } = await import('./embedding-local.js')
            warmupLocalEmbedding(cred.model).catch(() => {})
          }
        } catch {}
        jsonResponse(res, 200, { ok: true, embedding: getEmbeddingConfig() })
      } catch (err) {
        jsonResponse(res, 400, { ok: false, error: err.message })
      }
      return
    }

    // POST /settings/embedding/test — connectivity probe: compute one embedding to verify provider/key
    if (req.method === 'POST' && url.pathname === '/settings/embedding/test') {
      try {
        const { computeEmbedding, isEmbeddingConfigured } = await import('./embedding.js')
        if (!isEmbeddingConfigured()) {
          jsonResponse(res, 200, { ok: false, error: 'embedding not configured — save provider/model/apiKey first' })
          return
        }
        const t0 = Date.now()
        const buf = await computeEmbedding('embedding connectivity test')
        if (!buf) {
          jsonResponse(res, 200, { ok: false, error: 'computeEmbedding returned null — check apiKey / baseURL / model name; see server log if any' })
          return
        }
        const elapsed = Date.now() - t0
        const dims = buf.byteLength / 4 // Float32 = 4 bytes
        jsonResponse(res, 200, { ok: true, dims, elapsedMs: elapsed })
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message })
      }
      return
    }

    // GET /memory/embedding-backfill — current backfill status
    if (req.method === 'GET' && url.pathname === '/memory/embedding-backfill') {
      try {
        const { getBackfillStatus } = await import('./memory/embedding-backfill.js')
        jsonResponse(res, 200, { ok: true, status: getBackfillStatus() })
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message })
      }
      return
    }

    // POST /memory/embedding-backfill — fire-and-forget trigger backfill
    if (req.method === 'POST' && url.pathname === '/memory/embedding-backfill') {
      try {
        const { runBackfill, getBackfillStatus } = await import('./memory/embedding-backfill.js')
        const { isEmbeddingConfigured } = await import('./embedding.js')
        if (!isEmbeddingConfigured()) {
          jsonResponse(res, 200, { ok: false, error: 'embedding not configured' })
          return
        }
        const beforeStatus = getBackfillStatus()
        if (beforeStatus.running) {
          jsonResponse(res, 200, { ok: true, started: false, reason: 'already running', status: beforeStatus })
          return
        }
        // force=true：全量重算（切换嵌入模型后刷新维度）；否则只补 embedding IS NULL
        let force = false
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          force = !!body.force
        } catch {}
        // fire-and-forget：不 await，立即响应
        runBackfill({ batchSize: 20, throttleMs: 200, force }).catch(() => {})
        jsonResponse(res, 200, { ok: true, started: true, force, status: getBackfillStatus() })
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message })
      }
      return
    }

    // DELETE /memory/embedding-backfill — request cancel of running backfill
    if (req.method === 'DELETE' && url.pathname === '/memory/embedding-backfill') {
      try {
        const { cancelBackfill } = await import('./memory/embedding-backfill.js')
        cancelBackfill()
        jsonResponse(res, 200, { ok: true, cancelled: true })
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message })
      }
      return
    }

    // POST /tts/stream — streaming TTS synthesis, returns audio/mpeg stream
    if (req.method === 'POST' && url.pathname === '/tts/stream') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          // 统一在合成入口剥 markdown：模型回复带 **加粗** 等记号时，TTS 会把星号念成"星星"
          const text = stripMarkdownForSpeech(body.text)
          if (!text) { jsonResponse(res, 400, { ok: false, error: 'Missing text parameter' }); return }
          const creds = getTTSCredentials()
          // 合成前预检：服务商未选/凭证未配齐时给出可执行引导，而非冲到 streamTTS 才裸抛
          const check = validateTTSConfig(creds)
          if (!check.ok) { jsonResponse(res, 400, { ok: false, error: check.guide, needsConfig: true, provider: check.provider }); return }
          const audioStream = await streamTTS({
            text: text.slice(0, 800),
            provider: creds.provider,
            voiceId:  body.voiceId || creds.voiceId || undefined,
            keys: {
              doubaoKey:     creds.doubaoKey,
              doubaoAppId:   creds.doubaoAppId,
              doubaoAccessKey: creds.doubaoAccessKey,
              doubaoResourceId: creds.doubaoResourceId,
              doubaoStyle:   creds.doubaoStyle,
              doubaoSpeechRate: creds.doubaoSpeechRate,
              minimaxKey:    creds.minimaxKey,
              openaiKey:     creds.openaiKey,
              openaiBaseURL: creds.openaiBaseURL,
              elevenLabsKey: creds.elevenLabsKey,
              volcanoAppId:  creds.volcanoAppId,
              volcanoToken:  creds.volcanoToken,
            },
          })
          let headersWritten = false
          let responseDone = false
          let streamError = null
          const finishRes = () => { if (!responseDone) { responseDone = true; res.end() } }
          const errorRes = (msg) => { if (!responseDone) { responseDone = true; jsonResponse(res, 500, { ok: false, error: msg }) } }
          audioStream.on('data', (chunk) => {
            if (!headersWritten) {
              headersWritten = true
              res.writeHead(200, {
                'Content-Type': 'audio/mpeg',
                'Transfer-Encoding': 'chunked',
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*',
              })
            }
            res.write(chunk)
          })
          audioStream.on('end', () => {
            if (!headersWritten) {
              const errMsg = streamError?.message || 'TTS synthesis failed: API returned no audio — check whether the voice ID is enabled on your account'
              console.warn('[TTS] Empty stream:', errMsg)
              errorRes(errMsg)
            } else {
              finishRes()
            }
          })
          audioStream.on('error', (err) => {
            console.warn('[TTS] Audio stream error:', err.message)
            streamError = err
            if (!headersWritten) {
              errorRes(err.message)
            } else {
              finishRes()
            }
          })
        } catch (err) {
          console.warn('[TTS] Streaming synthesis failed:', err.message)
          if (!res.headersSent) jsonResponse(res, 500, { ok: false, error: err.message })
          else try { res.end() } catch {}
        }
      })
      return
    }

    // POST /tts/interrupted — TTS interrupted by user; trim the last jarvis message to the spoken portion
    if (req.method === 'POST' && url.pathname === '/tts/interrupted') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          const { spokenContent } = body
          if (typeof spokenContent !== 'string') { jsonResponse(res, 400, { error: 'spokenContent required' }); return }
          const updated = updateLastJarvisConversationContent(spokenContent)
          emitEvent('tts_interrupted', { spokenContent })
          jsonResponse(res, 200, { ok: true, updated })
        } catch (e) {
          jsonResponse(res, 500, { error: e.message })
        }
      })
      return
    }

    jsonResponse(res, 404, { error: 'not found' })
  })

  // Cloud ASR WebSocket channel: frontend PCM → backend proxy → cloud ASR
  const cloudWss = new WebSocketServer({ noServer: true })
  cloudWss.on('connection', (ws) => {
    let session = null
    let configured = false

    ws.on('message', (raw) => {
      // First frame must be a JSON config frame
      if (!configured) {
        try {
          const msg = JSON.parse(raw.toString())
          if (msg.type !== 'config') return
          // Read raw credentials from config.json
          let rawCfg = {}
          try { rawCfg = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))?.voice || {} } catch {}
          const provider = rawCfg.voiceProvider || msg.provider || 'aliyun'
          session = createCloudASRSession(
            { provider, lang: msg.lang || 'zh', ...rawCfg },
            (text, isFinal, seg) => {
              try { ws.send(JSON.stringify({ type: 'transcript', text, is_final: isFinal, seg })) } catch {}
            },
            (errMsg) => {
              try { ws.send(JSON.stringify({ type: 'error', message: errMsg })) } catch {}
            },
            () => { try { ws.close() } catch {} },
            // onEvent：把云端非转录事件（task-started/finished/failed）转发到前端诊断
            (event, info) => {
              try { ws.send(JSON.stringify({ type: 'diag', event, info })) } catch {}
            }
          )
          configured = true
        } catch {}
        return
      }
      // Subsequent frames are PCM binary
      if (raw instanceof Buffer) {
        session?.sendAudio(raw)
      } else {
        try {
          const msg = JSON.parse(raw.toString())
          if (msg.type === 'flush') session?.flush()
        } catch {}
      }
    })

    ws.on('close', () => { session?.close(); session = null })
    ws.on('error', () => { session?.close(); session = null })
  })

  // ---- Scene 协议(声明式 Agent-UI 架构,WS /scene)----
  const sceneWss = new WebSocketServer({ noServer: true })
  sceneWss.on('connection', (ws) => handleSceneConnection(ws))

  // 上行 intent:落库(复用 ui_signals 表)+ 在有语义的用户意图时推进 agent 队列。
  // 协议规定只有"有意义的用户意图"才上行;dismiss/ended 等生命周期意图只落库供被动注入,不打扰 agent。
  const SCENE_PASSIVE_INTENTS = new Set(['dismiss', 'ended', 'mounted', 'dwell'])
  setSceneIntentHandler((msg) => {
    const surface = msg.surface || 'scene'
    const name = msg.name || 'unknown'
    const data = msg.data || {}
    const id = insertUISignal({ type: `scene.intent.${name}`, target: msg.surface || null, payload: data, ts: msg.ts || Date.now() })
    emitEvent('ui_signal', { id, type: name, target: msg.surface, payload: data })

    // 安全确认回流：security-confirm-* 的 select intent 走 core 侧确定性处理（不卷入 Agent 回合）。
    // 待应用的变更存在该 surface 的 data.pending（execSetSecurity 写入），这里回查后直接 apply，
    // 与旧 ACUI confirm_security_change 行为一致；提前 return，不走下面的通用 APP_SIGNAL push。
    if (name === 'select' && surface.startsWith('security-confirm-')) {
      const pending = sceneStore.get(surface)?.data?.pending || {}
      sceneStore.set(surface, null)   // 无论确认/取消都先收起确认 surface
      if (data.value === 'confirm') {
        const updates = {}
        if (pending.file_sandbox !== undefined) updates.fileSandbox = pending.file_sandbox === true
        if (pending.exec_sandbox !== undefined) updates.execSandbox = pending.exec_sandbox === true
        const result = Object.keys(updates).length > 0 ? setSecurity(updates) : getSecurity()
        const desc = Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(', ')
        pushMessage(
          'SYSTEM',
          `[security settings updated] User confirmed changes: ${desc}. changed_at=${result.updatedAt || 'not recorded'}\n(Internal context refresh only. Do NOT call send_message.)`,
          'APP_SIGNAL',
          { queue: 'background', persist: false, silent: true },
        )
      } else {
        pushMessage('SYSTEM', '[security settings change] User cancelled — settings unchanged\n(Internal context refresh only. Do NOT call send_message.)', 'APP_SIGNAL', { queue: 'background', persist: false, silent: true })
      }
      return
    }

    if (!SCENE_PASSIVE_INTENTS.has(name)) {
      pushMessage(`UI:${surface}`, `[UI intent surface=${surface} name=${name}]\n${JSON.stringify(data, null, 2)}`, 'APP_SIGNAL')
    }
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://localhost:${port}`)
    if (url.pathname === '/scene') {
      const origin = req.headers.origin
      if (origin && !isAllowedOrigin(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      if (!hasAllowedAccess(req, url)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      sceneWss.handleUpgrade(req, socket, head, (ws) => sceneWss.emit('connection', ws, req))
    } else if (url.pathname === '/voice/cloud') {
      cloudWss.handleUpgrade(req, socket, head, (ws) => cloudWss.emit('connection', ws, req))
    } else {
      socket.destroy()
    }
  })

  server.listen(port, host, () => {
    console.log(`[API] Listening at http://${host}:${port}`)
    console.log(`[API]   POST /message  — send message to agent`)
    console.log(`[API]   GET  /events   — SSE real-time stream (receive agent messages)`)
    console.log(`[API]   GET  /memories — query memories`)
    console.log(`[API]   GET  /audit/recall, /audit/extract, /audit/stats — memory observability (Phase 0)`)
    console.log(`[API]   GET  /status   — status`)
    console.log(`[API]   WS   /scene    — Scene declarative UI channel`)
  })

  return server
}
