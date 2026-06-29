import { requestJson } from './http.js'
import { env } from './utils.js'

const POLL_INTERVAL_MS = 2000
const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 60000

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
        if (!msg || !msg.text || msg.from?.is_bot) continue

        const chatId = String(msg.chat.id)
        const fromId = `telegram:${chatId}`
        pushMessage(fromId, msg.text, 'TELEGRAM', {
          social: { platform: 'telegram', chat_id: chatId, message_id: msg.message_id },
        })
        emitEvent?.('message_in', {
          from_id: fromId,
          content: msg.text,
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

export async function sendTelegramMessage(chatId, content) {
  const token = env('TELEGRAM_BOT_TOKEN')
  if (!token) return { ok: false, skipped: true, reason: 'TELEGRAM_BOT_TOKEN not configured' }

  const res = await requestJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    body: { chat_id: Number(chatId), text: content },
  })
  if (!res.ok) throw new Error(`Telegram send failed HTTP ${res.status}: ${res.text}`)
  return { ok: true, platform: 'telegram', message_id: res.data?.result?.message_id || null }
}
