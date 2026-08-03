import fs from 'fs'
import crypto from 'crypto'
import path from 'path'
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
      baseURL: DEFAULT_BASE_URL,
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
    const baseURL = (config.comfyuiBaseURL || DEFAULT_BASE_URL).replace(/\/+$/, '')

    const headers = { 'Content-Type': 'application/json' }
    if (config.comfyuiToken) {
      const token = config.comfyuiToken.trim()
      headers['Authorization'] = token.includes(':')
        ? `Basic ${Buffer.from(token).toString('base64')}`
        : `Bearer ${token}`
    }

    const workflow = config.comfyuiWorkflowPath
      ? injectPromptIntoWorkflow(this.#readWorkflowFile(), prompt.trim())
      : buildComfyWorkflow({
          checkpoint: config.comfyuiCheckpoint,
          prompt: prompt.trim(),
          aspect_ratio,
          n: count,
        })

    const submitResp = await this.#postJson(baseURL, '/prompt', {
      prompt: workflow,
      client_id: crypto.randomUUID(),
    }, headers)
    const promptId = submitResp?.prompt_id
    if (!promptId) throw new Error('ComfyUI Image: /prompt response missing prompt_id')

    const outputs = await this.#pollHistory(promptId, headers, baseURL)
    const images = Object.values(outputs).flatMap(nodeOut =>
      Array.isArray(nodeOut?.images) ? nodeOut.images : [],
    )

    const urls = []
    for (const img of images) {
      const stored = await this.#fetchImage(img, headers, baseURL)
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

  async #postJson(baseURL, path, body, headers) {
    let res
    try {
      res = await fetch(`${baseURL}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      })
    } catch (err) {
      throw new Error(`ComfyUI 无法连接 (${baseURL})${err?.message ? `: ${err.message}` : ''}`)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`ComfyUI /prompt failed (${res.status}): ${text.slice(0, 300)}`)
    }
    return res.json()
  }

  async #pollHistory(promptId, headers, baseURL, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs
    const url = `${baseURL}/history/${encodeURIComponent(promptId)}`
    while (Date.now() < deadline) {
      let json = null
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
        if (res.ok) json = await res.json()
      } catch (err) {
        console.warn(`[comfyui] history poll error: ${err.message}`)
      }
      if (json) {
        const entry = json?.[promptId]
        const statusStr = entry?.status?.status_str
        if (statusStr === 'error') {
          const msg = extractComfyErrorMessage(entry?.status?.messages)
          throw new Error(`ComfyUI Image: generation failed${msg ? `: ${msg}` : ''}`)
        }
        const outputs = entry?.outputs
        if (outputs && Object.keys(outputs).length > 0) return outputs
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error(`ComfyUI Image: generation timed out after ${Math.round(timeoutMs / 1000)}s`)
  }

  async #fetchImage(img, headers, baseURL) {
    const params = new URLSearchParams({
      filename: img.filename || '',
      subfolder: img.subfolder || '',
      type: img.type || 'output',
    })
    const url = `${baseURL}/view?${params.toString()}`
    let res
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(60000) })
    } catch (err) {
      console.warn(`[comfyui] view fetch error: ${err.message}`)
      return null
    }
    if (!res.ok) {
      console.warn(`[comfyui] view fetch failed: ${res.status}`)
      return null
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    const ext = (img.filename && path.extname(img.filename)) || '.png'
    const mime = ext === '.jpg' ? 'image/jpeg'
      : ext === '.webp' ? 'image/webp'
      : ext === '.gif' ? 'image/gif'
      : 'image/png'
    return persistChatMediaBuffer(buffer, { ext, mime })
  }
}

function extractComfyErrorMessage(messages = []) {
  const parts = []
  for (const msg of messages) {
    if (!Array.isArray(msg) || msg.length < 2) continue
    const payload = msg[1]
    if (typeof payload === 'string') {
      const text = payload.split('\n')[0].trim()
      if (text) parts.push(text)
    } else if (payload && typeof payload === 'object') {
      const type = typeof payload.exception_type === 'string' ? payload.exception_type : ''
      const text = typeof payload.exception_message === 'string' ? payload.exception_message : ''
      if (type || text) parts.push(`${type}${type && text ? ': ' : ''}${text}`.trim())
    }
  }
  return parts.join(' | ').slice(0, 500)
}
