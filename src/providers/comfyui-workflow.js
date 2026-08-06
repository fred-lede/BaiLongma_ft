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
// resolution 為基準尺寸（1:1 時的邊長），預設 1024（FLUX 標準）。
// 結果取整到 64 的倍數，確保 latent → pixel 對齊無餘數。
export function aspectRatioToLatentSize(aspectRatio = '1:1', resolution = 1024) {
  const base = Number(resolution) || 1024
  const entry = ASPECT_TO_LATENT[aspectRatio] || ASPECT_TO_LATENT['1:1']
  // 原始尺寸已是 FLUX 標準倍數（8x VAE），只有縮放時才需取整
  if (base === 1024) return { width: entry.width, height: entry.height }
  const scale = base / 1024
  const width = Math.round(entry.width * scale / 64) * 64
  const height = Math.round(entry.height * scale / 64) * 64
  return { width, height }
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
 * 建內建 FLUX.1（schnell/dev）文生圖 workflow（API format），用於沒有
 * SD checkpoint、但有 flux 三件套（unet + t5xxl + clip_l + vae）的機器。
 * 節點架構對齊 ComfyUI 官方 FLUX.1 Schnell 模板（SamplerCustomAdvanced +
 * BasicGuider + BasicScheduler，無 FluxGuidance）。
 *   unet:  UNETLoader 的 unet_name（如 flux1-schnell.safetensors）
 *   t5:    t5xxl 的 clip_name（如 t5xxl_fp8_e4m3fn.safetensors）
 *   clipL: CLIP-L 的 clip_name（如 clip_l.safetensors）
 *   vae:   VAELoader 的 vae_name（如 flux_ae.safetensors）
 *   resolution: 基準尺寸（1024/1536/2048），預設 1024；比例按 FLUX 慣例縮放
 *   其餘參數同 buildComfyWorkflow。
 */
export function buildFluxWorkflow({
  unet = '',
  t5 = '',
  clipL = '',
  vae = '',
  prompt = '',
  aspect_ratio = '1:1',
  n = 1,
  seed = null,
  resolution = 1024,
} = {}) {
  const { width, height } = aspectRatioToLatentSize(aspect_ratio, resolution)
  const batch = Math.min(Math.max(Math.floor(Number(n) || 1), 1), 4)
  const randomSeed = seed == null ? Math.floor(Math.random() * 0x7fffffff) : Number(seed)

  return {
    '12': {
      class_type: 'UNETLoader',
      inputs: { unet_name: unet, weight_dtype: 'default' },
    },
    '11': {
      class_type: 'DualCLIPLoader',
      inputs: { clip_name1: t5, clip_name2: clipL, type: 'flux' },
    },
    '10': {
      class_type: 'VAELoader',
      inputs: { vae_name: vae },
    },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { text: String(prompt || ''), clip: ['11', 0] },
    },
    '22': {
      class_type: 'BasicGuider',
      inputs: { model: ['12', 0], conditioning: ['6', 0] },
    },
    '25': {
      class_type: 'RandomNoise',
      inputs: { noise_seed: randomSeed },
    },
    '16': {
      class_type: 'KSamplerSelect',
      inputs: { sampler_name: 'euler' },
    },
    '17': {
      class_type: 'BasicScheduler',
      inputs: { scheduler: 'simple', steps: 4, denoise: 1.0, model: ['12', 0] },
    },
    '5': {
      class_type: 'EmptyLatentImage',
      inputs: { width, height, batch_size: batch },
    },
    '13': {
      class_type: 'SamplerCustomAdvanced',
      inputs: {
        noise: ['25', 0],
        guider: ['22', 0],
        sampler: ['16', 0],
        sigmas: ['17', 0],
        latent_image: ['5', 0],
      },
    },
    '8': {
      class_type: 'VAEDecode',
      inputs: { samples: ['13', 0], vae: ['10', 0] },
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
