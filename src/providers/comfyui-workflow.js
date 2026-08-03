/**
 * ComfyUI workflow 纯函数（无 IO / 无 import，便于直接 node 测试）。
 *
 * 输出的是 ComfyUI HTTP API 格式（node-id -> { class_type, inputs }），
 * 可直接 POST 到 /prompt。
 */

export const ASPECT_TO_LATENT = {
  '1:1': { width: 1024, height: 1024 },
  '16:9': { width: 1344, height: 768 },
  '4:3': { width: 1152, height: 864 },
  '3:4': { width: 864, height: 1152 },
  '9:16': { width: 768, height: 1344 },
}

// 把 aspect ratio 轉成 latent 尺寸；未知值回退 1:1。
export function aspectRatioToLatentSize(aspectRatio = '1:1') {
  const entry = ASPECT_TO_LATENT[aspectRatio] || ASPECT_TO_LATENT['1:1']
  return { width: entry.width, height: entry.height }
}

/**
 * 建內建通用文生圖 workflow（API format）。
 *   checkpoint: ComfyUI 的 ckpt_name（如 sd_xl_base_1.0.safetensors）
 *   prompt:     正向提示詞
 *   aspect_ratio: 1:1 | 16:9 | 4:3 | 3:4 | 9:16
 *   n:          批次數量（clamp 1..4）
 *   seed:       固定 seed（預設隨機）
 */
export function buildComfyWorkflow({
  checkpoint = '',
  prompt = '',
  aspect_ratio = '1:1',
  n = 1,
  seed = null,
} = {}) {
  const { width, height } = aspectRatioToLatentSize(aspect_ratio)
  const batch = Math.min(Math.max(Math.floor(Number(n) || 1), 1), 4)
  const randomSeed = seed == null ? Math.floor(Math.random() * 0x7fffffff) : Number(seed)

  return {
    '4': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: checkpoint },
    },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { text: String(prompt || ''), clip: ['4', 1] },
    },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: { text: '', clip: ['4', 1] },
    },
    '5': {
      class_type: 'EmptyLatentImage',
      inputs: { width, height, batch_size: batch },
    },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: randomSeed,
        steps: 28,
        cfg: 7.0,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1.0,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '8': {
      class_type: 'VAEDecode',
      inputs: { samples: ['3', 0], vae: ['4', 2] },
    },
    '9': {
      class_type: 'SaveImage',
      inputs: { images: ['8', 0], filename_prefix: 'bailongma' },
    },
  }
}

/**
 * 把 prompt 注入使用者自訂 workflow（API format）中標題含 PROMPT 的
 * CLIPTextEncode 節點。找不到該節點就 throw（明確錯誤，不猜測）。
 * 原地修改並回傳同一份 workflow。
 */
export function injectPromptIntoWorkflow(workflow, prompt = '') {
  for (const node of Object.values(workflow)) {
    const title = String(node?._meta?.title || '')
    if (node?.class_type === 'CLIPTextEncode' && /^PROMPT$/i.test(title)) {
      node.inputs = { ...(node.inputs || {}), text: String(prompt || '') }
      return workflow
    }
  }
  throw new Error('ComfyUI custom workflow: no CLIPTextEncode node titled PROMPT found')
}
