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

  const wf5 = buildComfyWorkflow({ prompt: 'x', seed: 0 })
  assert(wf5['3'].inputs.seed === 0, 'seed 0 is honored as a fixed seed')
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

  const negAndPrompt = {
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'neg', clip: ['9', 1] }, _meta: { title: 'NegativePrompt' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: 'old', clip: ['9', 1] }, _meta: { title: 'PROMPT' } },
  }
  injectPromptIntoWorkflow(negAndPrompt, 'pos')
  assert(negAndPrompt['1'].inputs.text === 'neg', 'NegativePrompt node not treated as PROMPT')
  assert(negAndPrompt['2'].inputs.text === 'pos', 'exact PROMPT node filled')

  const onlyNeg = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'neg' }, _meta: { title: 'NegativePrompt' } } }
  let negThrew = false
  try {
    injectPromptIntoWorkflow(onlyNeg, 'x')
  } catch (err) {
    negThrew = /PROMPT/.test(err.message)
  }
  assert(negThrew, 'throws when only NegativePrompt node exists')
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
} else {
  console.log('\nAll ComfyUI workflow tests passed')
}
