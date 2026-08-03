/**
 * Provider 注册表
 *
 * 管理多个 Provider 实例，按能力类型路由请求。
 * 支持未来注册额外的 key 或其他提供商（OpenAI、ElevenLabs 等）。
 */

const providers = []

// 注册一个 provider 实例
export function registerProvider(provider) {
  providers.push(provider)
  console.log(`[Provider] 已注册: ${provider.name}`)
}

// 替换同名 provider（不存在则新增）
export function replaceProvider(provider) {
  const idx = providers.findIndex(p => p.name === provider.name)
  if (idx >= 0) {
    providers.splice(idx, 1, provider)
    console.log(`[Provider] 已替换: ${provider.name}`)
  } else {
    providers.push(provider)
    console.log(`[Provider] 已注册: ${provider.name}`)
  }
}

// 获取支持某能力的第一个可用 provider（可指定引擎名前缀，如 comfyui / aethermesh / minimax）
export function getProvider(capability, engine = '') {
  const candidates = providers.filter(p => p.canDo(capability))
  const engineName = String(engine || '').trim().toLowerCase()
  if (engineName) {
    const match = candidates.find(p => p.name.toLowerCase().startsWith(engineName))
    if (match) return match
  }
  const p = candidates[0]
  if (!p) throw new Error(`没有可用的 Provider 支持能力: "${capability}"`)
  return p
}

// 调用某能力（自动路由，可指定引擎）
export async function callCapability(capability, params, engine = '') {
  const provider = getProvider(capability, engine)
  return provider.call(capability, params)
}

// 获取所有 provider 的配额状态汇总
export function getAllQuotaStatus() {
  const result = {}
  for (const p of providers) {
    result[p.name] = p.getQuotaStatus()
  }
  return result
}

// 列出所有已注册的能力
export function listCapabilities() {
  const caps = new Set()
  for (const p of providers) {
    for (const cap of ['tts', 'music', 'lyrics', 'image']) {
      if (p.canDo(cap)) caps.add(cap)
    }
  }
  return [...caps]
}
