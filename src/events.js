// 内部事件总线：SSE 客户端管理 + 事件广播
const sseClients = new Set()

// 新客户端连上时需立即补发的"粘性"事件（如启动自检音效）
const stickyEvents = new Map()  // type → { data, ts }

export function setStickyEvent(type, data) {
  stickyEvents.set(type, { data, ts: new Date().toISOString() })
}

export function clearStickyEvent(type) {
  stickyEvents.delete(type)
}

// 发送所有待补发事件给指定 SSE 客户端（连接建立时调用）
export function flushStickyEvents(res) {
  for (const [type, { data, ts }] of stickyEvents) {
    try { res.write(`data: ${JSON.stringify({ type, data, ts })}\n\n`) } catch (_) {}
  }
}

export function addSSEClient(res) {
  sseClients.add(res)
}

export function removeSSEClient(res) {
  sseClients.delete(res)
}

export function emitEvent(type, data) {
  if (sseClients.size === 0) return
  const payload = JSON.stringify({ type, data, ts: new Date().toISOString() })
  for (const res of sseClients) {
    try {
      res.write(`data: ${payload}\n\n`)
    } catch (_) {
      sseClients.delete(res)
    }
  }
}
