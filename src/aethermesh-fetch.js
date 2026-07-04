// 編譯版 Electron 中 Node.js fetch (undici) 對 192.168.x.x 等本地 IP 報 EHOSTUNREACH。
// Chromium 網路層（net.fetch）不受此限。
//
// 解法：patch globalThis.fetch 為「智慧派送器」——
//   本地 IP（192.168.x / 10.x / 172.16-31.x / localhost）→ net.fetch
//   其餘（對外網）→ 原始 Node.js fetch
//
// 這樣 LLM / AetherMesh（都在 192.168.1.200）用 Chromium 層，
// 而 weather / trending / GitHub 等外部 API 仍用原本的 Node.js fetch。

const _originalFetch = globalThis.fetch

let _netFetch = null
try {
  const mod = await import('electron')
  _netFetch = (typeof mod.net?.fetch === 'function') ? mod.net.fetch : null
} catch {}

// 本地 IP 正則：localhost / 127.x / 192.168.x / 10.x / 172.16-31.x / [::1]
const LOCAL_IP_RE = /^(https?:\/\/)?(localhost|127(?:\.\d+){3}|192\.168(?:\.\d+){2}|10(?:\.\d+){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d+){2}|\[::1\]|0\.0\.0\.0)([:\/]|$)/i

function isLocalURL(input) {
  const urlStr = (typeof input === 'string') ? input
    : (input instanceof URL) ? input.href
    : (input?.url) || ''
  return LOCAL_IP_RE.test(urlStr)
}

if (_netFetch) {
  globalThis.fetch = function smartFetch(input, init) {
    if (isLocalURL(input)) return _netFetch(input, init)
    return _originalFetch(input, init)
  }
}

export async function aethermeshFetch(url, options = {}) {
  if (_netFetch) return _netFetch(url, options)
  return _originalFetch(url, options)
}
