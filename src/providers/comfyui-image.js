import fs from 'fs'
import crypto from 'crypto'
import { BaseProvider } from './base.js'
import { config } from '../config.js'
import { persistChatMediaBuffer } from '../chat-media.js'
import { recordDailyUsage } from '../quota.js'
import { buildComfyWorkflow, injectPromptIntoWorkflow } from './comfyui-workflow.js'

const DEFAULT_BASE_URL = 'http://122.116.209.1:8188'

export class ComfyUIImageProvider extends BaseProvider {
  constructor() {
    super({
      name: 'comfyui-image',
      apiKey: '',
      baseURL: (config.comfyuiBaseURL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    })
  }

  canDo(capability) {
    return capability === 'image'
  }

  async call(capability, params) {
    if (capability === 'image') return this.#image(params)
    throw new Error(`ComfyUIImageProvider does not support ${capability}`)
  }

  async #image({ prompt, aspect_ratio = '1:1', n = 1 }) {
    if (!prompt?.trim()) throw new Error('ComfyUI Image: prompt is required')
    const count = Math.min(Math.max(Math.floor(Number(n) || 1), 1), 4)

    const headers = { 'Content-Type': 'application/json' }
    if (config.comfyuiToken) headers['Authorization'] = `Bearer ${config.comfyuiToken}`

    const workflow = config.comfyuiWorkflowPath
      ? injectPromptIntoWorkflow(this.#readWorkflowFile(), prompt.trim())
      : buildComfyWorkflow({
          checkpoint: config.comfyuiCheckpoint,
          prompt: prompt.trim(),
          aspect_ratio,
          n: count,
        })

    const submitResp = await this.#postJson(`${this.baseURL}/prompt`, {
      prompt: workflow,
      client_id: crypto.randomUUID(),
    }, headers)
    const promptId = submitResp?.prompt_id
    if (!promptId) throw new Error('ComfyUI Image: /prompt response missing prompt_id')

    const outputs = await this.#pollHistory(promptId, headers)
    const images = Object.values(outputs).flatMap(nodeOut =>
      Array.isArray(nodeOut?.images) ? nodeOut.images : [],
    )

    const urls = []
    for (const img of images) {
      const stored = await this.#fetchImage(img, headers)
      if (stored) urls.push(stored.url)
    }

    if (!urls.length) throw new Error('ComfyUI Image: no valid image data')
    recordDailyUsage('image', count)
    return { urls }
  }

  #readWorkflowFile() {
    try {
      return JSON.parse(fs.readFileSync(config.comfyuiWorkflowPath, 'utf-8'))
    } catch (err) {
      throw new Error(`ComfyUI Image: cannot read workflow file: ${err.message}`)
    }
  }

  async #postJson(url, body, headers) {
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      })
    } catch (err) {
      throw new Error(`ComfyUI 无法连接 (${this.baseURL})`)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`ComfyUI /prompt failed (${res.status}): ${text.slice(0, 300)}`)
    }
    return res.json()
  }

  async #pollHistory(promptId, headers, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs
    const url = `${this.baseURL}/history/${encodeURIComponent(promptId)}`
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
        if (res.ok) {
          const json = await res.json()
          const outputs = json?.[promptId]?.outputs
          if (outputs && Object.keys(outputs).length > 0) return outputs
        }
      } catch (err) {
        console.warn(`[comfyui] history poll error: ${err.message}`)
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error(`ComfyUI Image: generation timed out after ${Math.round(timeoutMs / 1000)}s`)
  }

  async #fetchImage(img, headers) {
    const params = new URLSearchParams({
      filename: img.filename || '',
      subfolder: img.subfolder || '',
      type: img.type || 'output',
    })
    const url = `${this.baseURL}/view?${params.toString()}`
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(60000) })
    if (!res.ok) {
      console.warn(`[comfyui] view fetch failed: ${res.status}`)
      return null
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    return persistChatMediaBuffer(buffer, { ext: '.png', mime: 'image/png' })
  }
}
