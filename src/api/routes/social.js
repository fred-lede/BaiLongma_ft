import { emitEvent } from '../../events.js'
import { handleSocialWebhook, isSocialWebhookPath } from '../../social/webhooks.js'
import { getClawbotQR, logoutClawbot } from '../../social/wechat-clawbot.js'
import { getFeishuStatus } from '../../social/feishu-ws.js'
import { jsonResponse } from '../utils.js'

function checkLocalOrToken(req, res, url, requireLocalOrToken) {
  if (typeof requireLocalOrToken === 'function') return requireLocalOrToken(req, res, url)
  jsonResponse(res, 403, { ok: false, error: 'forbidden' })
  return false
}

export async function handleSocialRoutes(req, res, url, { hasAllowedAccess, requireLocalOrToken } = {}) {
  if (req.method === 'GET' && url.pathname === '/social/wechat-clawbot/qr') {
    if (!hasAllowedAccess?.(req, url)) {
      jsonResponse(res, 403, { ok: false, error: 'forbidden' })
      return true
    }
    jsonResponse(res, 200, { ok: true, ...getClawbotQR() })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/social/feishu/status') {
    if (!hasAllowedAccess?.(req, url)) {
      jsonResponse(res, 403, { ok: false, error: 'forbidden' })
      return true
    }
    const configured = !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET)
    jsonResponse(res, 200, { ok: true, status: getFeishuStatus(), configured })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/social/wechat-clawbot/logout') {
    if (!checkLocalOrToken(req, res, url, requireLocalOrToken)) return true
    logoutClawbot()
    emitEvent('social_status', { platform: 'wechat-clawbot', status: 'idle' })
    jsonResponse(res, 200, { ok: true })
    return true
  }

  if (isSocialWebhookPath(url.pathname)) {
    await handleSocialWebhook(req, res, url)
    return true
  }

  return false
}
