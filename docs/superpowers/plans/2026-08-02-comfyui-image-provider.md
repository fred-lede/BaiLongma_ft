# ComfyUI Image Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ComfyUI as a third image-generation engine for the `generate_image` tool, selectable in the settings UI, with a pure workflow-builder module and full test coverage.

**Architecture:** A new `ComfyUIImageProvider` talks to ComfyUI's HTTP API (`POST /prompt` → poll `GET /history/{id}` → `GET /view`). A new pure module `src/providers/comfyui-workflow.js` builds the built-in generic text-to-image workflow and injects the user prompt into custom API-format workflows. The provider registry's `getProvider(capability, engine)` gains engine matching so the settings "生圖引擎" dropdown (`config.imageEngine`) routes `generate_image` to ComfyUI / AetherMesh / MiniMax while leaving all other capabilities auto-routed.

**Tech Stack:** Node.js (Electron), ES modules (`"type": "module"`), undici `fetch`, ComfyUI HTTP API (standard `/prompt`, `/history`, `/view` endpoints).

**Spec:** `docs/superpowers/specs/2026-08-02-comfyui-image-provider-design.md`

---

### Task 1: Pure workflow-builder module (TDD)

The workflow module has no imports and no side effects — it is testable with plain `node`.

**Files:**
- Create: `src/providers/comfyui-workflow.js`
- Test: `src/test-comfyui-workflow.js`

- [ ] **Step 1: Write the failing test**

Create `src/test-comfyui-workflow.js`:

```js
// ComfyUI workflow 构建纯函数测试（无网络 / 无 DB，直接 import）。
//
// Run: node src/test-comfyui-workflow.js

import {
  aspectRatioToLatentSize,
  buildComfyWorkflow,
  injectPromptIntoWorkflow,
} from './providers/comfyui-workflow.js'

let failed = 0
function assert(cond, label) {
  if (!cond) {
    console.error(`FAIL: ${label}`)
    failed++
    process.exitCode = 1
  } else {
    console.log(`PASS: ${label}`)
  }
}

// ====== 1) aspectRatioToLatentSize ======
{
  assert(aspectRatioToLatentSize('1:1').width === 1024 && aspectRatioToLatentSize('1:1').height === 1024, '1:1 -> 1024x1024')
  assert(aspectRatioToLatentSize('16:9').width === 1344 && aspectRatioToLatentSize('16:9').height === 768, '16:9 -> 1344x768')
  assert(aspectRatioToLatentSize('4:3').width === 1152 && aspectRatioToLatentSize('4:3').height === 864, '4:3 -> 1152x864')
  assert(aspectRatioToLatentSize('3:4').width === 864 && aspectRatioToLatentSize('3:4').height === 1152, '3:4 -> 864x1152')
  assert(aspectRatioToLatentSize('9:16').width === 768 && aspectRatioToLatentSize('9:16').height === 1344, '9:16 -> 768x1344')
  assert(aspectRatioToLatentSize('bogus').width === 1024, 'unknown ratio falls back to 1:1 (1024x1024)')
  assert(aspectRatioToLatentSize().width === 1024, 'missing ratio falls back to 1:1 (1024x1024)')
}

// ====== 2) buildComfyWorkflow ======
{
  const wf = buildComfyWorkflow({
    checkpoint: 'sd_xl_base_1.0.safetensors',
    prompt: 'a cat',
    aspect_ratio: '16:9',
    n: 2,
    seed: 42,
  })

  assert(wf['4'].class_type === 'CheckpointLoaderSimple', 'node 4 is CheckpointLoaderSimple')
  assert(wf['4'].inputs.ckpt_name === 'sd_xl_base_1.0.safetensors', 'checkpoint wired')
  assert(wf['6'].class_type === 'CLIPTextEncode' && wf['6'].inputs.text === 'a cat', 'positive prompt injected')
  assert(wf['7'].class_type === 'CLIPTextEncode' && wf['7'].inputs.text === '', 'negative prompt empty')
  assert(wf['5'].class_type === 'EmptyLatentImage', 'node 5 is EmptyLatentImage')
  assert(wf['5'].inputs.width === 1344 && wf['5'].inputs.height === 768, 'latent size follows aspect ratio')
  assert(wf['5'].inputs.batch_size === 2, 'batch size follows n')
  assert(wf['3'].class_type === 'KSampler', 'node 3 is KSampler')
  assert(wf['3'].inputs.seed === 42 && wf['3'].inputs.steps === 28 && wf['3'].inputs.cfg === 7.0, 'KSampler params (seed/steps/cfg)')
  assert(JSON.stringify(wf['3'].inputs.model) === JSON.stringify(['4', 0]), 'KSampler.model -> checkpoint[0]')
  assert(JSON.stringify(wf['3'].inputs.positive) === JSON.stringify(['6', 0]), 'KSampler.positive -> positive CLIP[0]')
  assert(JSON.stringify(wf['3'].inputs.negative) === JSON.stringify(['7', 0]), 'KSampler.negative -> negative CLIP[0]')
  assert(JSON.stringify(wf['3'].inputs.latent_image) === JSON.stringify(['5', 0]), 'KSampler.latent_image -> EmptyLatentImage[0]')
  assert(wf['8'].class_type === 'VAEDecode' && JSON.stringify(wf['8'].inputs.samples) === JSON.stringify(['3', 0]), 'VAEDecode reads KSampler')
  assert(wf['9'].class_type === 'SaveImage' && JSON.stringify(wf['9'].inputs.images) === JSON.stringify(['8', 0]), 'SaveImage reads VAEDecode')
  assert(wf['9'].inputs.filename_prefix === 'bailongma', 'SaveImage prefix is bailongma')

  const wf2 = buildComfyWorkflow({ prompt: 'x' })
  assert(typeof wf2['3'].inputs.seed === 'number' && wf2['3'].inputs.seed >= 0, 'seed randomizes when not given')

  const wf3 = buildComfyWorkflow({ prompt: 'x', n: 99 })
  assert(wf3['5'].inputs.batch_size === 4, 'n clamped to max 4')
  const wf4 = buildComfyWorkflow({ prompt: 'x', n: 0 })
  assert(wf4['5'].inputs.batch_size === 1, 'n clamped to min 1')
}

// ====== 3) injectPromptIntoWorkflow ======
{
  const custom = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: 'old', clip: ['1', 1] }, _meta: { title: 'PROMPT' } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '4': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0] } },
  }
  injectPromptIntoWorkflow(custom, 'new prompt')
  assert(custom['2'].inputs.text === 'new prompt', 'PROMPT node filled')
  assert(custom['1'].inputs.ckpt_name === 'x.safetensors', 'other nodes untouched')
  assert(custom['4'].inputs.positive[0] === '2', 'node links untouched')

  const noPrompt = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } } }
  let threw = false
  try {
    injectPromptIntoWorkflow(noPrompt, 'y')
  } catch (err) {
    threw = /PROMPT/.test(err.message)
  }
  assert(threw, 'throws when no PROMPT-titled node exists')

  const lowerTitle = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a' }, _meta: { title: 'prompt' } } }
  let lowerThrew = false
  try {
    injectPromptIntoWorkflow(lowerTitle, 'b')
  } catch (err) {
    lowerThrew = true
  }
  assert(!lowerThrew && lowerTitle['1'].inputs.text === 'b', 'title match is case-insensitive')
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
} else {
  console.log('\nAll ComfyUI workflow tests passed')
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node src/test-comfyui-workflow.js`
Expected: `Error: Cannot find module .../src/providers/comfyui-workflow.js`

- [ ] **Step 3: Write the module**

Create `src/providers/comfyui-workflow.js`:

```js
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
  return ASPECT_TO_LATENT[aspectRatio] || ASPECT_TO_LATENT['1:1']
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node src/test-comfyui-workflow.js`
Expected: all `PASS` lines, then `All ComfyUI workflow tests passed`

- [ ] **Step 5: Add the npm script**

Modify `package.json` scripts (after the `test:voice-ptt` entry, ~line 47):

```json
    "test:comfyui-workflow": "node ./src/test-comfyui-workflow.js",
```

- [ ] **Step 6: Commit**

```bash
git add src/providers/comfyui-workflow.js src/test-comfyui-workflow.js package.json
git commit -m "feat: add pure ComfyUI workflow builder module"
```

---

### Task 2: Config fields + settings API route

**Files:**
- Modify: `src/config.js:1059` (config defaults), `src/config.js:1093-1095` (parse), `src/config.js:1422-1431` (`saveLLMSettings`)
- Modify: `src/api/routes/settings.js:78-99` (GET `/settings`), `src/api/routes/settings.js:117-129` (POST `/settings/model`)

- [ ] **Step 1: Add config defaults**

In `src/config.js`, after `imageGenModel: '',` (line 1059) inside the `config` object:

```js
  imageGenModel: '',
  imageEngine: '',
  comfyuiBaseURL: 'http://122.116.209.1:8188',
  comfyuiCheckpoint: '',
  comfyuiWorkflowPath: '',
  comfyuiToken: '',
```

- [ ] **Step 2: Load stored values**

In `src/config.js`, after the `imageGenModel` parse block (lines 1093-1095):

```js
  if (typeof parsedConfig.imageGenModel === 'string') {
    config.imageGenModel = parsedConfig.imageGenModel
  }
  if (typeof parsedConfig.imageEngine === 'string') {
    config.imageEngine = parsedConfig.imageEngine
  }
  if (typeof parsedConfig.comfyuiBaseURL === 'string') {
    config.comfyuiBaseURL = parsedConfig.comfyuiBaseURL
  }
  if (typeof parsedConfig.comfyuiCheckpoint === 'string') {
    config.comfyuiCheckpoint = parsedConfig.comfyuiCheckpoint
  }
  if (typeof parsedConfig.comfyuiWorkflowPath === 'string') {
    config.comfyuiWorkflowPath = parsedConfig.comfyuiWorkflowPath
  }
  if (typeof parsedConfig.comfyuiToken === 'string') {
    config.comfyuiToken = parsedConfig.comfyuiToken
  }
```

- [ ] **Step 3: Extend saveLLMSettings**

Replace the `saveLLMSettings` signature + image-save block (lines 1422-1431) with:

```js
export async function saveLLMSettings({
  provider = AUTO_PROVIDER,
  apiKey,
  model,
  baseURL,
  imageGenModel,
  imageEngine,
  comfyuiBaseURL,
  comfyuiCheckpoint,
  comfyuiWorkflowPath,
  comfyuiToken,
} = {}) {
  const p = String(provider || AUTO_PROVIDER).toLowerCase()
  const trimmedKey = String(apiKey || '').trim()

  const imageFields = {
    imageGenModel,
    imageEngine,
    comfyuiBaseURL,
    comfyuiCheckpoint,
    comfyuiWorkflowPath,
    comfyuiToken,
  }
  const hasImageFields = Object.values(imageFields).some(v => v !== undefined)
  if (hasImageFields) {
    const existing = readExistingStoredConfig()
    for (const [key, val] of Object.entries(imageFields)) {
      const trimmed = String(val ?? '').trim()
      existing[key] = trimmed
      config[key] = trimmed
    }
    writeStoredConfig(existing)
  }
```

Verify the rest of the function body (custom-provider branch, `switchProviderConfig`) is untouched.

- [ ] **Step 4: GET /settings returns the new fields**

In `src/api/routes/settings.js`, after `imageGenModel: config.imageGenModel || '',` (line 90):

```js
        imageGenModel: config.imageGenModel || '',
        imageEngine: config.imageEngine || '',
        comfyuiBaseURL: config.comfyuiBaseURL || '',
        comfyuiCheckpoint: config.comfyuiCheckpoint || '',
        comfyuiWorkflowPath: config.comfyuiWorkflowPath || '',
        comfyuiToken: config.comfyuiToken || '',
```

- [ ] **Step 5: POST /settings/model forwards the new fields**

In `src/api/routes/settings.js`, replace lines 119-122:

```js
      const { provider, apiKey, model, baseURL, imageGenModel, imageEngine, comfyuiBaseURL, comfyuiCheckpoint, comfyuiWorkflowPath, comfyuiToken } = await readJsonBody(req)
      const result = provider || apiKey || baseURL || imageGenModel || imageEngine || comfyuiBaseURL || comfyuiCheckpoint || comfyuiWorkflowPath || comfyuiToken
        ? await saveLLMSettings({ provider, apiKey, model, baseURL, imageGenModel, imageEngine, comfyuiBaseURL, comfyuiCheckpoint, comfyuiWorkflowPath, comfyuiToken })
        : switchModel(model)
```

- [ ] **Step 6: Syntax check**

Run: `node --check src/config.js && node --check src/api/routes/settings.js`
Expected: no output (exit 0)

- [ ] **Step 7: Commit**

```bash
git add src/config.js src/api/routes/settings.js
git commit -m "feat: persist ComfyUI image-engine config"
```

---

### Task 3: Registry engine routing

**Files:**
- Modify: `src/providers/registry.js:28-39`
- Modify: `src/capabilities/tools/media/generation.js:1-7,48-55`

- [ ] **Step 1: Add engine matching to registry**

In `src/providers/registry.js`, replace lines 28-39:

```js
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
```

- [ ] **Step 2: Pass engine from generate_image**

In `src/capabilities/tools/media/generation.js`, add the import after line 6:

```js
import { config } from '../../../config.js'
```

And change the image call (line 55):

```js
  const result = await callCapability('image', { prompt, aspect_ratio: ratio, n: count }, config.imageEngine)
```

- [ ] **Step 3: Syntax check**

Run: `node --check src/providers/registry.js && node --check src/capabilities/tools/media/generation.js`
Expected: no output (exit 0)

- [ ] **Step 4: Commit**

```bash
git add src/providers/registry.js src/capabilities/tools/media/generation.js
git commit -m "feat: route image generation by selected engine"
```

---

### Task 4: ComfyUIImageProvider

**Files:**
- Create: `src/providers/comfyui-image.js`

- [ ] **Step 1: Write the provider**

Create `src/providers/comfyui-image.js`:

```js
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
```

- [ ] **Step 2: Syntax check**

Run: `node --check src/providers/comfyui-image.js`
Expected: no output (exit 0)

- [ ] **Step 3: Commit**

```bash
git add src/providers/comfyui-image.js
git commit -m "feat: add ComfyUI image provider"
```

---

### Task 5: Register the provider at startup

**Files:**
- Modify: `src/index.js` (import area ~line 30-60, registration area ~line 236-237)

- [ ] **Step 1: Add import + registration**

Add the import with the other provider imports in `src/index.js`:

```js
import { ComfyUIImageProvider } from './providers/comfyui-image.js'
```

After `registerAetherMeshImageIfAvailable()` / `registerMinimaxIfAvailable()` (lines 236-237), add:

```js
registerProvider(new ComfyUIImageProvider())
```

Registration is unconditional — the provider falls back to defaults and reads live `config.comfyui*` at call time.

- [ ] **Step 2: Syntax check**

Run: `node --check src/index.js`
Expected: no output (exit 0)

- [ ] **Step 3: Commit**

```bash
git add src/index.js
git commit -m "feat: register ComfyUI image provider"
```

---

### Task 6: Settings UI (engine dropdown + ComfyUI section)

**Files:**
- Modify: `src/ui/brain-ui/app-shell.js:343-346`
- Modify: `src/ui/brain-ui/app.js` (element refs ~4365, load ~4617-4618, save ~5735-5736, plus new helpers)

- [ ] **Step 1: Replace the imagegen row with engine selector + ComfyUI section**

In `src/ui/brain-ui/app-shell.js`, replace lines 343-346:

```html
            <div class="settings-row">
              <label class="settings-label" for="settings-image-engine">生圖引擎</label>
              <select class="settings-select" id="settings-image-engine">
                <option value="">自動</option>
                <option value="comfyui">ComfyUI</option>
                <option value="aethermesh">AetherMesh</option>
                <option value="minimax">MiniMax</option>
              </select>
            </div>
            <div class="settings-row" id="settings-imagegen-model-row">
              <label class="settings-label" for="settings-imagegen-model">文生圖模型（AetherMesh）</label>
              <input class="settings-input" id="settings-imagegen-model" type="text" placeholder="如 x/z-image-turbo:bf16" autocomplete="off" spellcheck="false">
            </div>
            <div id="settings-comfyui-section" style="display:none;">
              <div class="settings-row">
                <label class="settings-label" for="settings-comfyui-baseurl">ComfyUI Base URL</label>
                <input class="settings-input" id="settings-comfyui-baseurl" type="text" placeholder="如 http://122.116.209.1:8188" autocomplete="off" spellcheck="false">
              </div>
              <div class="settings-row">
                <label class="settings-label" for="settings-comfyui-checkpoint">Checkpoint 檔名</label>
                <input class="settings-input" id="settings-comfyui-checkpoint" type="text" placeholder="如 sd_xl_base_1.0.safetensors" autocomplete="off" spellcheck="false">
              </div>
              <div class="settings-row">
                <label class="settings-label" for="settings-comfyui-workflow-path">自訂 Workflow JSON 路徑</label>
                <input class="settings-input" id="settings-comfyui-workflow-path" type="text" placeholder="可選：API-format workflow 檔的絕對路徑" autocomplete="off" spellcheck="false">
              </div>
              <div class="settings-row">
                <label class="settings-label" for="settings-comfyui-token">Token（可選）</label>
                <div class="settings-secret-wrap">
                  <input class="settings-input" id="settings-comfyui-token" type="password" placeholder="配合 --api-auth 使用" autocomplete="new-password">
                  <button class="settings-secret-toggle" id="settings-comfyui-token-toggle" type="button" aria-label="顯示 Token" title="顯示/隱藏 Token">👁</button>
                </div>
              </div>
            </div>
```

- [ ] **Step 2: Add element refs + toggle helpers**

In `src/ui/brain-ui/app.js`, near the `llmKeyToggle` ref (line 4365), add refs:

```js
  const imageEngineSelect    = document.getElementById("settings-image-engine");
  const imageGenModelRow     = document.getElementById("settings-imagegen-model-row");
  const comfyuiSection       = document.getElementById("settings-comfyui-section");
  const comfyuiBaseURLInput  = document.getElementById("settings-comfyui-baseurl");
  const comfyuiCheckpointIn  = document.getElementById("settings-comfyui-checkpoint");
  const comfyuiWorkflowIn    = document.getElementById("settings-comfyui-workflow-path");
  const comfyuiTokenInput    = document.getElementById("settings-comfyui-token");
  const comfyuiTokenToggle   = document.getElementById("settings-comfyui-token-toggle");
```

Near `setLlmKeyVisible` (line 4540), add two helpers:

```js
  function setComfyuiTokenVisible(visible) {
    if (comfyuiTokenInput) comfyuiTokenInput.type = visible ? "text" : "password";
    if (comfyuiTokenToggle) {
      comfyuiTokenToggle.setAttribute("aria-label", visible ? "隐藏 Token" : "显示 Token");
      comfyuiTokenToggle.title = visible ? "隐藏 Token" : "显示 Token";
    }
  }

  function syncImageEngineUI() {
    const engine = imageEngineSelect?.value || "";
    const isComfyui = engine === "comfyui";
    if (comfyuiSection) comfyuiSection.style.display = isComfyui ? "" : "none";
    if (imageGenModelRow) imageGenModelRow.style.display = isComfyui ? "none" : "";
  }
```

- [ ] **Step 3: Load values in loadSettings**

In `src/ui/brain-ui/app.js`, replace lines 4617-4618:

```js
      const imageGenModelEl = document.getElementById("settings-imagegen-model");
      if (imageGenModelEl) imageGenModelEl.value = llm.imageGenModel || "";
      if (imageEngineSelect) imageEngineSelect.value = llm.imageEngine || "";
      if (comfyuiBaseURLInput) comfyuiBaseURLInput.value = llm.comfyuiBaseURL || "";
      if (comfyuiCheckpointIn) comfyuiCheckpointIn.value = llm.comfyuiCheckpoint || "";
      if (comfyuiWorkflowIn) comfyuiWorkflowIn.value = llm.comfyuiWorkflowPath || "";
      if (comfyuiTokenInput) comfyuiTokenInput.value = llm.comfyuiToken || "";
      syncImageEngineUI();
```

- [ ] **Step 4: Save the new fields**

In `src/ui/brain-ui/app.js`, replace lines 5735-5736:

```js
      const imageGenModel = document.getElementById("settings-imagegen-model")?.value?.trim();
      if (imageGenModel !== undefined) body.imageGenModel = imageGenModel;
      const imageEngine = imageEngineSelect?.value || "";
      if (imageEngine) body.imageEngine = imageEngine;
      if (comfyuiBaseURLInput) body.comfyuiBaseURL = comfyuiBaseURLInput.value.trim();
      if (comfyuiCheckpointIn) body.comfyuiCheckpoint = comfyuiCheckpointIn.value.trim();
      if (comfyuiWorkflowIn) body.comfyuiWorkflowPath = comfyuiWorkflowIn.value.trim();
      if (comfyuiTokenInput) body.comfyuiToken = comfyuiTokenInput.value.trim();
```

- [ ] **Step 5: Wire event listeners**

In `src/ui/brain-ui/app.js`, add next to the existing `llmKeyToggle?.addEventListener` (line 5694):

```js
  imageEngineSelect?.addEventListener("change", syncImageEngineUI);
  comfyuiTokenToggle?.addEventListener("click", () => {
    setComfyuiTokenVisible(comfyuiTokenInput?.type === "password");
  });
```

- [ ] **Step 6: Syntax checks**

Run: `node --check src/ui/brain-ui/app-shell.js && node --check src/ui/brain-ui/app.js`
Expected: no output (exit 0)

- [ ] **Step 7: Commit**

```bash
git add src/ui/brain-ui/app-shell.js src/ui/brain-ui/app.js
git commit -m "feat: add image-engine selector and ComfyUI settings UI"
```

---

### Task 7: Full verification + smoke test

- [ ] **Step 1: Run the unit test**

Run: `npm run test:comfyui-workflow`
Expected: `All ComfyUI workflow tests passed`

- [ ] **Step 2: Syntax-check every touched file**

Run:

```bash
node --check src/providers/comfyui-workflow.js
node --check src/providers/comfyui-image.js
node --check src/providers/registry.js
node --check src/capabilities/tools/media/generation.js
node --check src/config.js
node --check src/api/routes/settings.js
node --check src/index.js
node --check src/ui/brain-ui/app-shell.js
node --check src/ui/brain-ui/app.js
```

Expected: all exit 0, no output

- [ ] **Step 3: Verify no regression in existing image path**

Run: `node src/test-media-modules.js`
Expected: all PASS lines

- [ ] **Step 4: Final commit if anything changed**

```bash
git status
git commit -am "chore: comfyui image provider polish"   # only if uncommitted changes exist
```

Then report to user: engine dropdown renders in settings, ComfyUI section toggles on 生圖引擎=ComfyUI, and the workflow-builder unit test passes. Ask user to rebuild and point the ComfyUI section at their PC (`http://122.116.209.1:8188`) to smoke-test a real `generate_image` call.
