import assert from 'node:assert/strict'
import {
  BROWSER_TOOLS,
  capabilityContextBlocks,
  findCapabilitiesByQuery,
} from './capabilities/capability-registry.js'
import { selectTools } from './memory/tool-router.js'
import { classifyTool, evaluateToolPolicy } from './capabilities/tool-policy.js'
import { BUILTIN_PLAYWRIGHT_ALLOWED_TOOLS } from './mcp/playwright-server.js'
import {
  buildToolAuditRecord,
  sanitizeToolAuditArgs,
  summarizeToolExecution,
} from './capabilities/tool-audit.js'
import { TOOL_SCHEMAS } from './capabilities/builtin-tools.js'
import { getToolSchemas } from './capabilities/schemas.js'

const EXPECTED_BROWSER_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_find',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_hover',
  'browser_drag',
  'browser_wait_for',
  'browser_handle_dialog',
  'browser_tabs',
  'browser_take_screenshot',
  'browser_console_messages',
  'browser_resize',
  'browser_close',
]
const FORBIDDEN_BROWSER_TOOLS = [
  'browser_sessions',
  'browser_open',
  'browser_inspect',
  'browser_act',
  'browser_run_code_unsafe',
  'browser_evaluate',
  'browser_file_upload',
  'browser_drop',
]
const MUTATING_BROWSER_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_hover',
  'browser_drag',
  'browser_wait_for',
  'browser_handle_dialog',
  'browser_tabs',
  'browser_resize',
  'browser_close',
]
const READ_ONLY_BROWSER_TOOLS = [
  'browser_snapshot',
  'browser_find',
  'browser_take_screenshot',
  'browser_console_messages',
]
const STATELESS_WEB_TOOLS = ['web_search', 'web_read', 'fetch_url', 'browser_read']
const LEGACY_BROWSER_TOOLS = ['browser_sessions', 'browser_open', 'browser_inspect', 'browser_act']
const REMOVED_WEB_AND_BROWSER_TOOLS = [...STATELESS_WEB_TOOLS, ...LEGACY_BROWSER_TOOLS]

assert.deepEqual(BROWSER_TOOLS, EXPECTED_BROWSER_TOOLS,
  'browser capability uses official Playwright MCP remote names in a fixed safe allowlist')
assert.deepEqual([...BROWSER_TOOLS].sort(), [...BUILTIN_PLAYWRIGHT_ALLOWED_TOOLS].sort(),
  'router allowlist matches the built-in MCP process boundary')
assert.ok(FORBIDDEN_BROWSER_TOOLS.every(name => !BROWSER_TOOLS.includes(name)),
  'legacy browser tools, arbitrary JavaScript, and local-file ingress are not exposed')
assert.ok(REMOVED_WEB_AND_BROWSER_TOOLS.every(name => TOOL_SCHEMAS[name] === undefined),
  'removed web and self-built browser tools have no built-in model schema')
assert.deepEqual(getToolSchemas(REMOVED_WEB_AND_BROWSER_TOOLS), [],
  'schema lookup cannot expose removed web or self-built browser tools')
assert.deepEqual(findCapabilitiesByQuery('fill form')[0]?.tools, BROWSER_TOOLS,
  'find_tool discovery loads the same official safe allowlist')

for (const messageBody of [
  '打开浏览器', '打开网页', '继续刚才页面', '当前页面', '浏览器是否开着', '关闭浏览器',
  '切换标签页', '点击填写登录', '打开 https://example.com/path', '浏览器操作', '网页截图',
  'open the browser', 'continue the previous page', 'current page', 'close browser',
  'switch tabs', 'click the login button', 'fill the form', 'sign in', 'open example.com', 'open this link',
  '访问 https://example.com', 'visit example.com', 'go to https://example.com', '查看网站 https://example.com',
  'browser automation', 'interact with the page', 'take a screenshot',
]) {
  const routed = selectTools({ messageBody, isTick: false })
  assert.ok(BROWSER_TOOLS.every(name => routed.includes(name)), `stateful browser route: ${messageBody}`)
  assert.ok([...FORBIDDEN_BROWSER_TOOLS, ...STATELESS_WEB_TOOLS].every(name => !routed.includes(name)),
    `legacy/unsafe tools excluded: ${messageBody}`)
}

for (const messageBody of [
  'ClickHouse query', 'database table schema', 'tabular report',
  'Playwright browser context architecture', 'Browser API type definitions',
  'web worker lifecycle', 'URL parser implementation', 'React tab component',
  'Google OAuth implementation', '搜索算法实现', 'JavaScript webpage rendering architecture',
  'go to definition in the editor', 'visit pattern implementation',
]) {
  const routed = selectTools({ messageBody, isTick: false })
  assert.ok(BROWSER_TOOLS.every(name => !routed.includes(name)), `non-browser term does not trigger Playwright: ${messageBody}`)
  assert.ok(REMOVED_WEB_AND_BROWSER_TOOLS.every(name => !routed.includes(name)),
    `ordinary technical term does not trigger removed web/browser tools: ${messageBody}`)
}

for (const messageBody of [
  'summarize this article', 'extract article content', 'read page content',
  '总结这篇文章正文', '提取文章正文',
  'read this JavaScript-rendered article content', '用无头浏览器提取动态网页正文',
]) {
  const routed = selectTools({ messageBody, isTick: false })
  assert.ok(BROWSER_TOOLS.every(name => routed.includes(name)),
    `one-shot body read injects official Playwright: ${messageBody}`)
  assert.ok(REMOVED_WEB_AND_BROWSER_TOOLS.every(name => !routed.includes(name)),
    `one-shot body read excludes removed tools: ${messageBody}`)
}

const combined = selectTools({
  messageBody: 'search online then open website and click the first link',
  isTick: false,
})
assert.ok(BROWSER_TOOLS.every(name => combined.includes(name))
  && REMOVED_WEB_AND_BROWSER_TOOLS.every(name => !combined.includes(name)),
  'combined search + interaction uses only official Playwright tools')

assert.ok(BROWSER_TOOLS.every(name => !selectTools({
  messageBody: 'click',
  isTick: false,
}).includes(name)), 'objectless exact click requires recent browser continuity evidence')

const continued = selectTools({
  messageBody: 'click',
  isTick: false,
  recentActionLog: [{ tool: 'browser_snapshot' }],
})
assert.ok(BROWSER_TOOLS.every(name => continued.includes(name)),
  'a recent official Playwright action restores the complete safe group for a terse follow-up')
assert.ok([...FORBIDDEN_BROWSER_TOOLS, ...STATELESS_WEB_TOOLS].every(name => !continued.includes(name)),
  'browser continuity cannot restore legacy, unsafe, or removed web tools')

const unrelatedAfterBrowser = selectTools({
  messageBody: 'explain this project architecture',
  isTick: false,
  recentActionLog: [{ tool: 'browser_snapshot' }],
})
assert.ok(BROWSER_TOOLS.every(name => !unrelatedAfterBrowser.includes(name)),
  'a recent browser action does not leak one stranded action tool into an unrelated turn')

const oldAction = selectTools({
  messageBody: '继续',
  isTick: false,
  recentActionLog: [{ tool: 'browser_act' }, { tool: 'browser_open' }],
})
assert.ok(FORBIDDEN_BROWSER_TOOLS.every(name => !oldAction.includes(name)),
  'historical ActionLog entries cannot revive removed self-built tools')
assert.ok(STATELESS_WEB_TOOLS.every(name => !oldAction.includes(name)),
  'historical ActionLog entries cannot revive removed stateless web tools')

const browserContext = capabilityContextBlocks({
  text: '打开网页并点击登录',
  rawText: '打开网页并点击登录',
  isTick: false,
}).find(block => block.includes('Microsoft Playwright MCP Only')) || ''
assert.match(browserContext, /browser_navigate[\s\S]*automatically return a fresh accessibility snapshot/)
assert.match(browserContext, /instead of routinely calling browser_snapshot/)
assert.match(browserContext, /browser_find/)
assert.match(browserContext, /relative filename/)
assert.match(browserContext, /browser_snapshot rather than a screenshot/)
for (const name of ['browser_run_code_unsafe', 'browser_evaluate', 'browser_file_upload', 'browser_drop']) {
  assert.match(browserContext, new RegExp(name), `${name} is explicitly unavailable in the workflow`)
}
for (const legacyTerm of ['browser_sessions', 'browser_open', 'session_id', 'page_id', 'ref epoch', 'persistent profile']) {
  assert.equal(browserContext.includes(legacyTerm), false, `legacy prompt term removed: ${legacyTerm}`)
}

for (const name of MUTATING_BROWSER_TOOLS) {
  assert.equal(evaluateToolPolicy(name, {}, { autonomous: true }).allowed, false,
    `autonomous Tick cannot call mutating MCP browser tool: ${name}`)
  assert.equal(evaluateToolPolicy(name, {}, {}).allowed, true,
    `user-driven context can call allowlisted MCP browser tool: ${name}`)
}
for (const name of READ_ONLY_BROWSER_TOOLS) {
  assert.equal(classifyTool(name), 'low', `${name} has a read-only fallback risk classification`)
}

const urlSecret = `AUDIT_URL_SECRET_${Date.now()}_${Math.random()}`
for (const name of ['browser_navigate', 'browser_tabs']) {
  const safeBrowserArgs = sanitizeToolAuditArgs(name, {
    action: name === 'browser_tabs' ? 'new' : undefined,
    url: `https://user:password@example.com/path?token=${urlSecret}#${urlSecret}`,
  })
  assert.equal(safeBrowserArgs.url, 'https://example.com/path')
  assert.equal(JSON.stringify(safeBrowserArgs).includes(urlSecret), false)
}

const secret = `FORM_SECRET_${Date.now()}_${Math.random()}`
const sanitizedType = sanitizeToolAuditArgs('browser_type', {
  element: 'Password', target: 'ref-1', text: secret, submit: true,
})
assert.equal(sanitizedType.text, '[redacted]')
assert.equal(summarizeToolExecution('browser_type', sanitizedType),
  'browser_type(target=ref-1)')

const sanitizedForm = sanitizeToolAuditArgs('browser_fill_form', {
  fields: [
    { name: 'Email', type: 'textbox', target: 'ref-2', value: secret },
    { name: 'Remember me', type: 'checkbox', target: 'ref-3', value: 'true' },
  ],
})
assert.deepEqual(sanitizedForm.fields.map(field => field.value), ['[redacted]', '[redacted]'])
assert.equal(summarizeToolExecution('browser_fill_form', sanitizedForm),
  'browser_fill_form(fields=2)')

for (const name of ['browser_type', 'browser_fill_form']) {
  const args = name === 'browser_type'
    ? { target: 'ref-secret', text: secret }
    : { fields: [{ name: 'Secret', type: 'textbox', target: 'ref-secret', value: secret }] }
  const log = buildToolAuditRecord({
    name,
    args,
    context: {},
    policy: { risk: 'high' },
    status: 'error',
    result: JSON.stringify({ ok: false, echoed: secret }),
    error: `failed to input ${secret}`,
    startedAt: Date.now(),
  })
  const persistedAudit = JSON.stringify(log)
  assert.equal(persistedAudit.includes(secret), false,
    `${name} sensitive text is absent from the entire persisted audit record`)
  assert.equal(log.argsJson.includes('[redacted]'), true)
  assert.equal(log.resultPreview, 'browser input failed')
  assert.equal(log.error, 'browser input failed')
}

console.log('test-browser-agent-integration passed')
