import { BaseProvider } from './base.js'
import { aethermeshFetch } from '../aethermesh-fetch.js'
import { persistChatMediaBuffer } from '../chat-media.js'
import { recordDailyUsage } from '../quota.js'

const ASPECT_TO_SIZE = {
  '1:1': '1024x1024',
  '16:9': '1344x768',
  '4:3': '1152x864',
  '3:4': '864x1152',
  '9:16': '768x1344',
}

export class AetherMeshImageProvider extends BaseProvider {
  constructor({ baseURL, apiKey, model } = {}) {
    super({
      name: 'aethermesh-image',
      apiKey: apiKey || '',
      baseURL: (baseURL || 'http://192.168.1.200:8001').replace(/\/+$/, ''),
    })
    this.model = model || 'x/z-image-turbo:bf16'
  }

  canDo(capability) {
    return capability === 'image'
  }

  async call(capability, params) {
    if (capability === 'image') return this.#image(params)
    throw new Error(`AetherMeshImageProvider does not support ${capability}`)
  }

  async #image({ prompt, aspect_ratio = '1:1', n = 1 }) {
    if (!prompt?.trim()) throw new Error('AetherMesh Image: prompt is required')
    const size = ASPECT_TO_SIZE[aspect_ratio] || '1024x1024'
    const count = Math.min(Math.max(Number(n) || 1, 1), 4)

    const url = `${this.baseURL}/v1/images/generations`
    const headers = { 'Content-Type': 'application/json' }
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`

    const body = JSON.stringify({
      model: this.model,
      prompt: prompt.trim(),
      n: count,
      size,
      response_format: 'b64_json',
    })

    const resp = await aethermeshFetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(120000),
    })

    if (!resp.ok) {
      const err = await resp.text().catch(() => '')
      throw new Error(`AetherMesh Image failed (${resp.status}): ${err.slice(0, 300)}`)
    }

    const json = await resp.json()
    if (!json.data?.length) throw new Error('AetherMesh Image: no images in response')

    const urls = []
    for (const item of json.data) {
      if (!item.b64_json) continue
      const buffer = Buffer.from(item.b64_json, 'base64')
      const stored = persistChatMediaBuffer(buffer, { ext: '.png', mime: 'image/png' })
      urls.push(stored.url)
    }

    if (!urls.length) throw new Error('AetherMesh Image: no valid image data')
    recordDailyUsage('image', count)
    return { urls }
  }
}
