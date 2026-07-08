import http from 'http'
import fs from 'fs'
import net from 'net'
import crypto from 'crypto'
import { aethermeshFetch } from './aethermesh-fetch.js'

// AetherMesh voice duration cache (refreshed every 5 min)
let _amVoiceCache = { voices: [], ts: 0 }
const AM_VOICE_CACHE_TTL = 5 * 60 * 1000
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import { handleSceneConnection, setSceneIntentHandler } from './scene/scene-server.js'
import { sceneStore } from './scene/scene-store.js'
import { pushMessage } from './inbound-message.js'
import { getDB, getConfig, insertUISignal } from './db.js'
import { emitEvent, setStickyEvent } from './events.js'
import { getNetworkConfig, getSecurity, setSecurity, config, getActivationStatus } from './config.js'
import { paths } from './paths.js'
import path from 'node:path'
import { createCloudASRSession } from './voice/cloud-asr.js'
import { getHotspots, setHotspotPanelState, getHotspotPanelState } from './hotspots.js'
import { getWorldcup, setWorldcupPanelState, getWorldcupPanelState } from './worldcup.js'
import { getPersonCard, setPersonCardPanelState, getPersonCardPanelState, setPersonCardVoice, setPersonCardLanguage, getPersonCardLanguage } from './person-cards.js'
import { setDocPanelState, getDocPanelState, DOC_TOPICS } from './docs.js'
import { getTraces, getTrace, clearTraces, getTraceStatus } from './runtime/turn-trace.js'
import { getTerminalStreamSnapshot } from './terminal-stream.js'
import { getSelfEvolutionSnapshot } from './memory/self-evolution.js'
import { markdownImage, mimeFromChatMediaExt, persistChatMediaDataUrl } from './chat-media.js'
import { isRunning } from './control.js'
import { isSocialWebhookPath, handleSocialWebhook } from './social/webhooks.js'
import { getFeishuStatus } from './social/feishu-ws.js'
import { logoutClawbot } from './social/wechat-clawbot.js'
import { jsonResponse, isPathInside, readJsonBody, contentTypeFor } from './api/utils.js'
import { appendInboundChatMediaMarkdown } from './api/inbound-media.js'
import { getAgentName } from './api/agent.js'
import { handleActivationRoutes } from './api/routes/activation.js'
import { handleAdminRoutes } from './api/routes/admin.js'
import { handleEmbeddingRoutes } from './api/routes/embedding.js'
import { handleEventRoutes } from './api/routes/events.js'
import { handleMediaRoutes } from './api/routes/media.js'
import { handleMemoryRoutes } from './api/routes/memory.js'
import { handleMessageRoutes } from './api/routes/message.js'
import { handlePanelRoutes } from './api/routes/panels.js'
import { handleSettingsRoutes } from './api/routes/settings.js'
import { handleSocialRoutes } from './api/routes/social.js'
import { handleStaticRoutes } from './api/routes/static.js'
import { handleTTSRoutes } from './api/routes/tts.js'

export { emitEvent }

const INDEX_PATH = paths.indexHtml
const BRAIN_UI_ASSET_ROOT = paths.brainUiAssetRoot
const SCENE_SHELL_ASSET_ROOT = path.join(paths.resourcesDir, 'src', 'ui', 'scene-shell')
const D3_VENDOR_PATH = path.join(paths.resourcesDir, 'node_modules', 'd3', 'dist', 'd3.min.js')
const DEFAULT_API_HOST = '127.0.0.1'

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

function setCorsHeaders(req, res, origin) {
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || 'null')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

async function dispatchHttpRoutes(req, res, url, context) {
  if (await handleMessageRoutes(req, res, url)) return true
  if (await handleEventRoutes(req, res, url)) return true
  if (await handleMemoryRoutes(req, res, url)) return true
  if (await handlePanelRoutes(req, res, url, context)) return true
  if (await handleMediaRoutes(req, res, url)) return true
  if (await handleActivationRoutes(req, res, url, context)) return true
  if (await handleSettingsRoutes(req, res, url, context)) return true
  if (await handleEmbeddingRoutes(req, res, url)) return true
  if (await handleAdminRoutes(req, res, url, context)) return true
  if (await handleTTSRoutes(req, res, url)) return true
  if (await handleStaticRoutes(req, res, url)) return true
  return false
}

function attachCloudASR(server, port) {
  const cloudWss = new WebSocketServer({ noServer: true })
  cloudWss.on('connection', (ws) => {
    let session = null
    let configured = false

    ws.on('message', (raw) => {
      if (!configured) {
        try {
          const msg = JSON.parse(raw.toString())
          if (msg.type !== 'config') return
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
            (event, info) => {
              try { ws.send(JSON.stringify({ type: 'diag', event, info })) } catch {}
            },
          )
          configured = true
        } catch {}
        return
      }

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

  return cloudWss
}

function attachSceneProtocol() {
  const sceneWss = new WebSocketServer({ noServer: true })
  sceneWss.on('connection', (ws) => handleSceneConnection(ws))

  const SCENE_PASSIVE_INTENTS = new Set(['dismiss', 'ended', 'mounted', 'dwell'])
  setSceneIntentHandler((msg) => {
    const surface = msg.surface || 'scene'
    const name = msg.name || 'unknown'
    const data = msg.data || {}
    const id = insertUISignal({ type: `scene.intent.${name}`, target: msg.surface || null, payload: data, ts: msg.ts || Date.now() })
    emitEvent('ui_signal', { id, type: name, target: msg.surface, payload: data })

    if (name === 'select' && surface.startsWith('security-confirm-')) {
      const pending = sceneStore.get(surface)?.data?.pending || {}
      sceneStore.set(surface, null)
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
        pushMessage(
          'SYSTEM',
          '[security settings change] User cancelled - settings unchanged\n(Internal context refresh only. Do NOT call send_message.)',
          'APP_SIGNAL',
          { queue: 'background', persist: false, silent: true },
        )
      }
      return
    }

    if (!SCENE_PASSIVE_INTENTS.has(name)) {
      pushMessage(`UI:${surface}`, `[UI intent surface=${surface} name=${name}]\n${JSON.stringify(data, null, 2)}`, 'APP_SIGNAL')
    }
  })

  return sceneWss
}

function attachWebSocketUpgrades(server, port, { sceneWss, cloudWss }) {
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

  function clearPreparedActivation() {
    pendingActivation = null
  }

  try {
    const storedName = (getConfig('agent_name') || '').trim()
    if (storedName) setStickyEvent('agent_name_updated', { name: storedName })
  } catch {}

  const routeContext = {
    getStateSnapshot,
    hasAllowedAccess,
    requireLocalOrToken,
    storePreparedActivation,
    getPreparedActivation,
    clearPreparedActivation,
    onActivated: onActivatedCallback,
  }

  const server = http.createServer(async (req, res) => {
    const base = `http://localhost:${port}`
    const url = new URL(req.url, base)
    const origin = req.headers.origin

    try {
      if (await handleSocialRoutes(req, res, url, { hasAllowedAccess, requireLocalOrToken })) return

      if (origin && !isAllowedOrigin(origin)) {
        return jsonResponse(res, 403, { ok: false, error: 'forbidden origin' })
      }

      if (!hasAllowedAccess(req, url)) {
        return jsonResponse(res, 403, { ok: false, error: 'forbidden' })
      }

      setCorsHeaders(req, res, origin)

      if (req.method !== 'OPTIONS' && isSensitivePath(url.pathname) && !requireLocalOrToken(req, res, url)) return

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      if (await dispatchHttpRoutes(req, res, url, routeContext)) return
    jsonResponse(res, 404, { error: 'not found' })
    } catch (err) {
      console.error('[API] request failed:', err)
      if (!res.headersSent) jsonResponse(res, 500, { ok: false, error: err.message || 'internal error' })
      else try { res.end() } catch {}
    }
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
          // Read raw credentials from config.json (voice + merge tts for aethermesh)
          let rawCfg = {}
          try { rawCfg = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))?.voice || {} } catch {}
          try {
            const ttsCfg = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))?.tts || {}
            rawCfg.aethermeshKey = rawCfg.aethermeshKey || ttsCfg.aethermeshKey || ''
            rawCfg.aethermeshBaseURL = rawCfg.aethermeshBaseURL || ttsCfg.aethermeshBaseURL || 'http://192.168.1.200:8001'
          } catch {}
          const provider = rawCfg.voiceProvider || msg.provider || 'aliyun'
          session = createCloudASRSession(
            { provider, lang: msg.lang || 'zh', ...rawCfg },
            (text, isFinal, seg, language) => {
              console.error('[cloudWss] onTranscript isFinal=' + isFinal + ' text=' + (text||'').slice(0,20));
              try { ws.send(JSON.stringify({ type: 'transcript', text, is_final: isFinal, seg, language: language || '' })) } catch {}
            },
            (errMsg) => {
              try { ws.send(JSON.stringify({ type: 'error', message: errMsg })) } catch {}
            },
            () => {
              // AetherMesh backend disconnected — DO NOT close frontend WS.
              // Backend will auto-reconnect (createAetherMeshSession reconnects automatically).
              // Only close frontend WS if it was intentionally closed by the user.
            },
            // onEvent：把云端非转录事件（task-started/finished/failed）转发到前端诊断
            (event, info) => {
              try { ws.send(JSON.stringify({ type: 'diag', event, info })) } catch {}
            }
          )
          configured = true
        } catch {}
        return
      }
      // Try JSON control messages first; fallback to PCM binary.
      // (ws may deliver text frames as Buffer — old instanceof Buffer check would
      // then misroute flush/config as audio.)
      let handled = false
      if (typeof raw === 'string' || raw instanceof Buffer) {
        try {
          const txt = typeof raw === 'string' ? raw : raw.toString()
          if (txt.startsWith('{')) {
            const msg = JSON.parse(txt)
            handled = true
            if (msg.type === 'flush') {
              const p = session?.flush()
              if (p && typeof p.then === 'function') p.catch(e => console.error('[WS] flush error:', e))
            }
          }
        } catch {}
      }
      if (!handled && raw instanceof Buffer) {
        session?.sendAudio(raw)
      }
    })

    ws.on('close', (code, reason) => {
      console.error(`[cloudWss] frontend WS closed code=${code||'?'} reason='${reason||''}'`)
      if (session) {
        // Frontend WS closed — do NOT destroy the backend session.
        // For AetherMesh: its own reconnect logic handles re-establishing.
        // For other ASR providers: session stays alive for PCM forwarding.
        // Only null out the reference; session lifecycle is independent.
        session = null
      }
    })
    ws.on('error', (err) => {
      console.error(`[cloudWss] frontend WS error: ${err.message||err}`)
      if (session) { session = null }
    })
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

  attachWebSocketUpgrades(server, port, { sceneWss, cloudWss })

  server.listen(port, host, () => {
    console.log(`[API] Listening at http://${host}:${port}`)
    console.log('[API]   POST /message  - send message to agent')
    console.log('[API]   GET  /events   - SSE real-time stream (receive agent messages)')
    console.log('[API]   GET  /memories - query memories')
    console.log('[API]   GET  /audit/recall, /audit/extract, /audit/stats - memory observability (Phase 0)')
    console.log('[API]   GET  /status   - status')
    console.log('[API]   WS   /scene    - Scene declarative UI channel')
  })

  return server
}
