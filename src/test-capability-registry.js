// 能力机制（capability-registry）纯算法测试。
// registry 顶层只 import 纯/惰性模块，不碰 DB/网络，可直接 node 跑（与 tool-router 同）。
//
// Run: node src/test-capability-registry.js

import {
  CAPABILITIES,
  capabilityToolsFor,
  capabilityContextBlocks,
  findCapabilitiesByQuery,
  listCapabilities,
} from './capabilities/capability-registry.js'

let failed = 0
function assert(cond, label) {
  if (!cond) { console.error(`FAIL: ${label}`); failed++; process.exitCode = 1 }
  else { console.log(`PASS: ${label}`) }
}
const has = (arr, x) => arr.includes(x)
const none = (arr, xs) => xs.every(x => !arr.includes(x))

// ctx 构造器：text 小写正文 + rawText 原文 + isTick
function ctx(rawText, isTick = false) {
  return { text: String(rawText || '').toLowerCase(), rawText: String(rawText || ''), isTick }
}

// ===== 1) 能力清单 =====
{
  const caps = listCapabilities()
  const ids = caps.map(c => c.id)
  assert(['web', 'weather', 'hotspot', 'worldcup', 'software-install'].every(id => ids.includes(id)),
    `1) listCapabilities 含五个 v1 能力 (got: ${ids.join(',')})`)
  assert(caps.every(c => c.label && c.summary), '1) 每个能力都有 label + summary（自感知用）')
}

// ===== 2) tool 注入门解耦 =====
{
  // web：关键词命中 → web 工具
  const t = capabilityToolsFor(ctx('搜一下 vLLM'))
  assert(has(t, 'web_search') && has(t, 'fetch_url'), `2a) web 关键词 → web 工具 (got: ${t.join(',')})`)
}
{
  // web：TICK 也注入（与旧 selectTools `|| isTick` 一致）
  const t = capabilityToolsFor(ctx('', true))
  assert(has(t, 'web_search'), '2b) TICK → web 工具')
  // hotspot 工具只在 TICK 注入
  assert(has(t, 'hotspot_mode'), '2b) TICK → hotspot_mode')
}
{
  // hotspot 关键词但非 TICK → 不注入 hotspot 工具（只递规则块，工具靠 find_tool）
  const t = capabilityToolsFor(ctx('看看今天的热搜'))
  assert(none(t, ['hotspot_mode']), `2c) 热点关键词(非TICK) 不自动注入 hotspot_mode (got: ${t.join(',')})`)
}
{
  // worldcup 永不自动注入工具
  const t = capabilityToolsFor(ctx('世界杯比分怎么样'))
  assert(none(t, ['worldcup_mode']), `2d) 世界杯关键词不自动注入 worldcup_mode (got: ${t.join(',')})`)
}
{
  // software-install → install_software
  const t = capabilityToolsFor(ctx('帮我安装一个 QQ'))
  assert(has(t, 'install_software'), `2e) 安装意图 → install_software (got: ${t.join(',')})`)
}
{
  // 天气 → 带上 web 工具（修复旧路径偶尔无 fetch 的缺口）
  const t = capabilityToolsFor(ctx('深圳天气怎么样'))
  assert(has(t, 'fetch_url'), `2f) 天气 → 带上 web 工具(fetch_url) (got: ${t.join(',')})`)
}

// ===== 3) 工作流块注入（context）=====
{
  assert(capabilityContextBlocks(ctx('今天天气')).some(b => b.includes('Weather Surface Rules')),
    '3a) 天气 → Weather Surface Rules 块')
  assert(capabilityContextBlocks(ctx('看热搜')).some(b => b.includes('Hotspot Panel')),
    '3b) 热点 → Hotspot Panel 块')
  assert(capabilityContextBlocks(ctx('世界杯赛况')).some(b => b.includes('World Cup Panel')),
    '3c) 世界杯 → World Cup Panel 块')
  assert(capabilityContextBlocks(ctx('安装微信')).some(b => b.includes('Software Install Workflow')),
    '3d) 安装 → Software Install Workflow 块')
  assert(capabilityContextBlocks(ctx('随便聊两句')).length === 0,
    '3e) 中性消息 → 无能力工作流块')
}

// ===== 4) find_tool 能力发现（自感知按需激活）=====
{
  const hits = findCapabilitiesByQuery('装软件')
  assert(hits.some(c => c.id === 'software-install'), '4a) "装软件" → 发现 software-install 能力')
  assert(hits.find(c => c.id === 'software-install')?.tools.includes('install_software'),
    '4a) 发现的能力带 install_software 工具')
  assert(!!hits.find(c => c.id === 'software-install')?.context,
    '4a) 发现的能力带 context（工作流，供回带摘要）')
}
{
  assert(findCapabilitiesByQuery('看热点').some(c => c.id === 'hotspot'), '4b) "看热点" → 发现 hotspot')
  assert(findCapabilitiesByQuery('天气').some(c => c.id === 'weather'), '4c) "天气" → 发现 weather')
  assert(findCapabilitiesByQuery('上网搜索').some(c => c.id === 'web'), '4d) "上网搜索" → 发现 web')
  assert(findCapabilitiesByQuery('').length === 0, '4e) 空 query → 无发现')
}

if (failed === 0) console.log('\nAll capability-registry checks complete.')
else console.log(`\n${failed} check(s) failed.`)
