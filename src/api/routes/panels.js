import { buildHeartbeatSystemPromptPreview } from '../../system-prompt-preview.js'
import { getHotspots, getHotspotPanelState, setHotspotPanelState } from '../../hotspots.js'
import { getWorldcup, getWorldcupPanelState, setWorldcupPanelState } from '../../worldcup.js'
import { DOC_TOPICS, getDocPanelState, setDocPanelState } from '../../docs.js'
import { getPersonCard, getPersonCardPanelState, setPersonCardPanelState, setPersonCardVoice, setPersonCardLanguage } from '../../person-cards.js'
import { getAgentName } from '../agent.js'
import { aethermeshFetch } from '../../aethermesh-fetch.js'
import { jsonResponse, parseBooleanish, readJsonBody } from '../utils.js'

export async function handlePanelRoutes(req, res, url, { getStateSnapshot = null } = {}) {
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
    return true
  }

  if (url.pathname === '/hotspot-state') {
    if (req.method === 'GET') {
      jsonResponse(res, 200, { ok: true, state: getHotspotPanelState() })
      return true
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const active = parseBooleanish(body.active)
        const state = setHotspotPanelState({ active, source: body.source || 'brain-ui' })
        jsonResponse(res, 200, { ok: true, state })
      } catch (err) {
        jsonResponse(res, 400, { ok: false, error: err.message })
      }
      return true
    }
  }

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
    return true
  }

  if (url.pathname === '/worldcup-state') {
    if (req.method === 'GET') {
      jsonResponse(res, 200, { ok: true, state: getWorldcupPanelState() })
      return true
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const active = parseBooleanish(body.active)
        const state = setWorldcupPanelState({ active, source: body.source || 'brain-ui' })
        jsonResponse(res, 200, { ok: true, state })
      } catch (err) {
        jsonResponse(res, 400, { ok: false, error: err.message })
      }
      return true
    }
  }

  if (url.pathname === '/doc-panel-state') {
    if (req.method === 'GET') {
      jsonResponse(res, 200, { ok: true, state: getDocPanelState() })
      return true
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const active = parseBooleanish(body.active)
        const state = setDocPanelState({ active, topicId: body.topicId || null, source: body.source || 'brain-ui' })
        jsonResponse(res, 200, { ok: true, state })
      } catch (err) {
        jsonResponse(res, 400, { ok: false, error: err.message })
      }
      return true
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/docs/')) {
    const topicId = url.pathname.slice(6)
    const doc = DOC_TOPICS[topicId]
    if (!doc) {
      jsonResponse(res, 404, { ok: false, error: `unknown topic: ${topicId}` })
      return true
    }
    jsonResponse(res, 200, { ok: true, doc })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/docs') {
    const topics = Object.values(DOC_TOPICS).map(({ id, title, subtitle, icon, summary }) => ({ id, title, subtitle, icon, summary }))
    jsonResponse(res, 200, { ok: true, topics })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/person-card') {
    const name = url.searchParams.get('name') || url.searchParams.get('q') || ''
    jsonResponse(res, 200, { ok: true, card: getPersonCard(name) })
    return true
  }

  if (url.pathname === '/person-card-state') {
    if (req.method === 'GET') {
      jsonResponse(res, 200, { ok: true, state: getPersonCardPanelState() })
      return true
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const active = parseBooleanish(body.active)
        const state = setPersonCardPanelState({
          active,
          source: body.source || 'brain-ui',
          card: body.card || null,
          name: body.name || '',
        })
        jsonResponse(res, 200, { ok: true, state })
      } catch (err) {
        jsonResponse(res, 400, { ok: false, error: err.message })
      }
      return true
    }
  }

  if (req.method === 'GET' && url.pathname === '/system-prompt-preview') {
    Promise.resolve()
      .then(() => buildHeartbeatSystemPromptPreview({
        stateSnapshot: typeof getStateSnapshot === 'function' ? getStateSnapshot() : {},
      }))
      .then((preview) => jsonResponse(res, 200, preview))
      .catch((err) => jsonResponse(res, 500, { error: err.message }))
    return true
  }

  if (req.method === 'GET' && url.pathname === '/agent-profile') {
    jsonResponse(res, 200, { name: getAgentName() })
    return true
  }

  // POST /person-card/voice - save per-user voice preference
  if (req.method === 'POST' && url.pathname === '/person-card/voice') {
    readJsonBody(req)
      .then((body) => {
        const ok = setPersonCardVoice(body.name, body.voiceId)
        jsonResponse(res, 200, { ok, voice_id: body.voiceId })
      })
      .catch((err) => jsonResponse(res, 400, { ok: false, error: err.message }))
    return true
  }

  // POST /person-card/language - save per-user language preference
  if (req.method === 'POST' && url.pathname === '/person-card/language') {
    readJsonBody(req)
      .then((body) => {
        const ok = setPersonCardLanguage(body.name, body.language)
        jsonResponse(res, 200, { ok, language: body.language })
      })
      .catch((err) => jsonResponse(res, 400, { ok: false, error: err.message }))
    return true
  }

  // GET /person-card/aethermesh-voices — proxy AetherMesh voice list (avoids CORS)
  if (req.method === 'GET' && url.pathname === '/person-card/aethermesh-voices') {
    ;(async () => {
      try {
        const { getTTSCredentials } = await import('../../config.js')
        const creds = getTTSCredentials()
        const baseURL = (creds.aethermeshBaseURL || 'http://localhost:8001').replace(/\/$/, '')
        const proxyHeaders = {}
        if (creds.aethermeshKey) proxyHeaders['Authorization'] = `Bearer ${creds.aethermeshKey}`
        const proxyRes = await aethermeshFetch(`${baseURL}/v1/voices`, { headers: proxyHeaders, signal: AbortSignal.timeout(8000) })
        if (!proxyRes.ok) {
          const errText = await proxyRes.text()
          throw new Error(`AetherMesh 获取声音列表失败 (${proxyRes.status}): ${errText.slice(0, 200)}`)
        }
        const data = await proxyRes.json()
        const list = Array.isArray(data) ? data : (data.data || data.voices || data.voice_ids || [])
        list.forEach(v => {
          const dur = v.duration_seconds || 0
          if (dur > 15) {
            v._warning = `參考音頻 ${dur.toFixed(1)}s 過長（>15s），XTTS-v2 合成會異常`
          }
        })
        jsonResponse(res, 200, { ok: true, voices: list })
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message })
      }
    })()
    return true
  }

  // PATCH /person-card/aethermesh-rename — proxy AetherMesh voice rename (avoids CORS)
  if (req.method === 'PATCH' && url.pathname === '/person-card/aethermesh-rename') {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', async () => {
      try {
        const { voiceId, name } = JSON.parse(Buffer.concat(chunks).toString())
        if (!voiceId || !name) { jsonResponse(res, 400, { ok: false, error: '缺少 voiceId 或 name' }); return }
        const { getTTSCredentials } = await import('../../config.js')
        const creds = getTTSCredentials()
        const baseURL = (creds.aethermeshBaseURL || 'http://localhost:8001').replace(/\/$/, '')
        const proxyHeaders = { 'Content-Type': 'application/json' }
        if (creds.aethermeshKey) proxyHeaders['Authorization'] = `Bearer ${creds.aethermeshKey}`
        const proxyRes = await aethermeshFetch(`${baseURL}/v1/voices/${voiceId}`, {
          method: 'PATCH',
          headers: proxyHeaders,
          body: JSON.stringify({ name }),
        })
        if (!proxyRes.ok) {
          const errText = await proxyRes.text()
          throw new Error(`AetherMesh 更名失败 (${proxyRes.status}): ${errText.slice(0, 200)}`)
        }
        jsonResponse(res, 200, { ok: true })
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message })
      }
    })
    return true
  }

  // POST /person-card/aethermesh-register — proxy AetherMesh voice registration (avoids CORS)
  if (req.method === 'POST' && url.pathname === '/person-card/aethermesh-register') {
    ;(async () => {
      try {
        const { getTTSCredentials } = await import('../../config.js')
        const creds = getTTSCredentials()
        const baseURL = (creds.aethermeshBaseURL || 'http://localhost:8001').replace(/\/$/, '')
        const proxyHeaders = { 'Content-Type': req.headers['content-type'] || 'multipart/form-data' }
        if (creds.aethermeshKey) proxyHeaders['Authorization'] = `Bearer ${creds.aethermeshKey}`
        const reqBody = await new Promise((resolve, reject) => {
          const bc = []; req.on('data', c => bc.push(c)); req.on('end', () => resolve(Buffer.concat(bc))); req.on('error', reject)
        })
        const proxyRes = await aethermeshFetch(`${baseURL}/v1/voices`, {
          method: 'POST',
          headers: proxyHeaders,
          body: reqBody,
        })
        if (!proxyRes.ok) {
          const errText = await proxyRes.text()
          throw new Error(`AetherMesh 注册声音失败 (${proxyRes.status}): ${errText.slice(0, 200)}`)
        }
        const data = await proxyRes.json()
        jsonResponse(res, 200, { ok: true, voice_id: data.voice_id || data.id || '' })
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message })
      }
    })()
    return true
  }

  // POST /person-card/clone-voice - upload audio to AetherMesh clone (proxied directly)
  if (req.method === 'POST' && url.pathname === '/person-card/clone-voice') {
    ;(async () => {
      try {
        const { getTTSCredentials } = await import('../../config.js')
        const creds = getTTSCredentials()
        const baseURL = (creds.aethermeshBaseURL || 'http://localhost:8001').replace(/\/$/, '')
        const proxyHeaders = { 'Content-Type': req.headers['content-type'] }
        if (creds.aethermeshKey) proxyHeaders['Authorization'] = `Bearer ${creds.aethermeshKey}`
        const reqBody = await new Promise((resolve, reject) => {
          const bc = []; req.on('data', c => bc.push(c)); req.on('end', () => resolve(Buffer.concat(bc))); req.on('error', reject)
        })
        const proxyRes = await aethermeshFetch(`${baseURL}/v1/voices`, {
          method: 'POST',
          headers: proxyHeaders,
          body: reqBody,
        })
        if (!proxyRes.ok) {
          const errText = await proxyRes.text()
          throw new Error(`AetherMesh 克隆失败 (${proxyRes.status}): ${errText.slice(0, 200)}`)
        }
        const data = await proxyRes.json()
        jsonResponse(res, 200, { ok: true, voice_id: data.voice_id || data.id || data.voiceId || '' })
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message })
      }
    })()
    return true
  }

  return false
}
