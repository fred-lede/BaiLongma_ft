import fs from 'fs'
import os from 'os'
import path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-playwright-mcp-'))
process.env.BAILONGMA_USER_DIR = tmp
process.env.BAILONGMA_RESOURCES_DIR = tmp

let failed = 0
function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`PASS: ${label}`)
    return
  }
  failed += 1
  process.exitCode = 1
  console.error(`FAIL: ${label}${detail ? `\n  ${detail}` : ''}`)
}

function parseJson(value) {
  try { return JSON.parse(String(value || '')) } catch { return null }
}

const {
  BUILTIN_PLAYWRIGHT_ALLOWED_TOOLS,
  BUILTIN_PLAYWRIGHT_BLOCKED_ORIGINS,
  BUILTIN_PLAYWRIGHT_INTERACTIVE_ID,
  BUILTIN_PLAYWRIGHT_READER_ID,
  createBuiltInPlaywrightServer,
} = await import('./playwright-server.js')
const {
  __internal: mcpInternal,
  executeBuiltInPlaywrightTool,
  executeMcpTool,
  getMcpStatus,
  getMcpToolSchema,
  listMcpTools,
  reconcileMcpClients,
  shutdownBuiltInPlaywright,
  shutdownMcpClients,
} = await import('./client-manager.js')
const { config } = await import('../config.js')

const advertisedTools = [
  {
    name: 'browser_navigate',
    description: 'Navigate',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'browser_snapshot',
    description: 'Snapshot',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  ...[
    'browser_run_code_unsafe',
    'browser_evaluate',
    'browser_file_upload',
    'browser_drop',
    'browser_network_requests',
    'browser_network_request',
  ].map(name => ({
    name,
    description: `Unsafe ${name}`,
    inputSchema: { type: 'object', properties: {} },
    annotations: {},
  })),
]

class FakeTransport {
  constructor(params) {
    this.params = params
    this.stderr = { on() {} }
  }
}

class FakeClient {
  static calls = []
  static instances = []

  constructor() {
    FakeClient.instances.push(this)
  }

  setNotificationHandler() {}

  async connect(transport) {
    this.transport = transport
  }

  async listTools() {
    return { tools: advertisedTools }
  }

  async callTool(request) {
    FakeClient.calls.push({ request, args: this.transport.params.args })
    return {
      content: [{ type: 'text', text: `called:${request.name}` }],
      structuredContent: { called: request.name },
    }
  }

  async close() {
    this.onclose?.()
  }
}

const deps = {
  ClientClass: FakeClient,
  TransportClass: FakeTransport,
  builtInOptions: {
    cliPath: path.join(tmp, 'playwright-mcp-cli.js'),
    command: '/fake/electron',
    resourcesDir: tmp,
    userDir: tmp,
    sandboxDir: path.join(tmp, 'sandbox'),
    env: {
      PLAYWRIGHT_BROWSERS_PATH: path.join(tmp, 'browsers'),
      UNRELATED_SECRET: 'must-not-leak',
    },
    electronRuntime: true,
  },
}

try {
  const interactive = createBuiltInPlaywrightServer({
    role: 'interactive',
    ...deps.builtInOptions,
  })
  assert(interactive.id === BUILTIN_PLAYWRIGHT_INTERACTIVE_ID, 'interactive server has a reserved stable id')
  assert(interactive.command === '/fake/electron', 'packaged server uses the supplied Electron executable')
  assert(interactive.env.ELECTRON_RUN_AS_NODE === '1', 'packaged Electron child runs in Node mode')
  assert(interactive.env.UNRELATED_SECRET === undefined, 'built-in child receives only explicit Playwright environment')
  assert(interactive.env.BAILONGMA_BROWSER_PRIVATE_NETWORK === '0',
    'child request guard defaults to private-network blocked')
  assert(interactive.args.includes('--user-data-dir'), 'interactive server uses a persistent profile')
  assert(interactive.args.includes('--init-page')
    && interactive.args[interactive.args.indexOf('--init-page') + 1].endsWith('src/mcp/playwright-page-guard.cjs'),
    'built-in server installs Bailongma request-level URL guard')
  assert(interactive.args.includes('--browser')
    && interactive.args[interactive.args.indexOf('--browser') + 1] === 'chromium',
    'built-in server selects the bundled Chrome for Testing channel')
  assert(interactive.args.includes('--snapshot-mode')
    && interactive.args[interactive.args.indexOf('--snapshot-mode') + 1] === 'full',
    'navigation and action results automatically include fresh accessibility snapshots')
  assert(interactive.args.includes('--blocked-origins')
    && BUILTIN_PLAYWRIGHT_BLOCKED_ORIGINS.every(origin => (
      interactive.args[interactive.args.indexOf('--blocked-origins') + 1].includes(origin)
    )),
    'private-network-disabled server installs the documented origin guardrail')
  assert(!interactive.args.includes('--headless') && !interactive.args.includes('--isolated'),
    'interactive server remains headed and persistent')
  assert(interactive.cwd === path.join(tmp, 'sandbox', 'browser-output', 'interactive'),
    'Playwright filesystem scope is rooted in its dedicated Bailongma sandbox output directory')

  const automaticSnapshotPath = path.join(interactive.cwd, 'page-auto-test.yml')
  fs.writeFileSync(automaticSnapshotPath, '- textbox "Search" [ref=e1]\n- button "Submit" [ref=e2]\n')
  const hydrated = parseJson(mcpInternal.formatMcpToolResult({
    alias: 'browser_navigate',
    remoteName: 'browser_navigate',
    serverId: interactive.id,
    serverName: interactive.name,
  }, {
    content: [{
      type: 'text',
      text: '### Snapshot\n- [Snapshot](page-auto-test.yml)',
    }],
  }, { serverConfig: interactive }))
  const hydratedText = hydrated?.content?.[0]?.text || ''
  assert(hydratedText.includes('textbox "Search" [ref=e1]')
    && !hydratedText.includes('[Snapshot](page-auto-test.yml)'),
  'built-in result adapter automatically inlines the official snapshot artifact',
  hydratedText)

  const outsideSnapshot = path.join(tmp, 'page-outside.yml')
  fs.writeFileSync(outsideSnapshot, 'SECRET_OUTSIDE_SNAPSHOT_ROOT')
  const outsideResult = parseJson(mcpInternal.formatMcpToolResult({
    alias: 'browser_navigate',
    remoteName: 'browser_navigate',
    serverId: interactive.id,
    serverName: interactive.name,
  }, {
    content: [{
      type: 'text',
      text: `### Snapshot\n- [Snapshot](${outsideSnapshot})`,
    }],
  }, { serverConfig: interactive }))
  assert(!JSON.stringify(outsideResult).includes('SECRET_OUTSIDE_SNAPSHOT_ROOT'),
    'automatic snapshot hydration cannot read outside the dedicated MCP output directory')

  const reader = createBuiltInPlaywrightServer({
    role: 'reader',
    ...deps.builtInOptions,
  })
  assert(reader.id === BUILTIN_PLAYWRIGHT_READER_ID, 'reader server has a reserved stable id')
  assert(reader.args.includes('--headless') && reader.args.includes('--isolated'),
    'reader server is headless and isolated')
  assert(!reader.args.includes('--user-data-dir') && reader.catalogVisible === false,
    'reader has no persistent profile and is hidden from the model catalog')

  const privateNetworkServer = createBuiltInPlaywrightServer({
    role: 'interactive',
    ...deps.builtInOptions,
    allowPrivateNetwork: true,
  })
  assert(!privateNetworkServer.args.includes('--blocked-origins'),
    'explicit Bailongma private-network permission removes the origin guardrail')
  assert(privateNetworkServer.env.BAILONGMA_BROWSER_PRIVATE_NETWORK === '1',
    'explicit private-network permission also disables the request-level guard')

  const userServer = {
    id: 'user_server',
    name: 'User MCP',
    enabled: true,
    transport: 'stdio',
    command: '/fake/node',
    args: ['/fake/user-server.js'],
    cwd: '',
    env: {},
    allowedTools: [],
    allowAutonomousReadOnly: false,
    timeoutMs: 10_000,
  }
  await reconcileMcpClients([userServer], deps)

  const tools = listMcpTools()
  assert(tools.some(tool => tool.name === 'browser_navigate' && tool.builtIn === true),
    'built-in Playwright tools use their native remote names', JSON.stringify(tools))
  assert(tools.some(tool => tool.name === 'mcp__user_server__browser_navigate' && tool.builtIn === false),
    'user MCP tools remain namespaced', JSON.stringify(tools))
  assert(!tools.some(tool => [
    'browser_run_code_unsafe',
    'browser_evaluate',
    'browser_file_upload',
    'browser_drop',
    'browser_network_requests',
    'browser_network_request',
  ].includes(tool.name)), 'unsafe official Playwright tools are absent from the native catalog', JSON.stringify(tools))
  assert(BUILTIN_PLAYWRIGHT_ALLOWED_TOOLS.every(name => ![
    'browser_run_code_unsafe',
    'browser_evaluate',
    'browser_file_upload',
    'browser_drop',
    'browser_network_requests',
    'browser_network_request',
  ].includes(name)), 'fixed allowlist excludes code, upload, drop, and network-detail tools')
  assert(getMcpToolSchema('browser_navigate')?.function?.parameters?.required?.includes('url'),
    'native Playwright schema is available to the unified tool catalog')

  const result = parseJson(await executeBuiltInPlaywrightTool(
    'browser_navigate',
    { url: 'https://example.com' },
    {
      mcpDeps: deps,
      webUrlPolicyOptions: {
        hostnameResolver: async () => [{ address: '93.184.216.34' }],
      },
    },
  ))
  assert(result?.ok === true && result?.remote_tool === 'browser_navigate',
    'internal interactive API calls an allowed remote tool', JSON.stringify(result))

  const beforePrivateCall = FakeClient.calls.length
  const privateNavigation = parseJson(await executeMcpTool(
    'browser_navigate',
    { url: 'http://127.0.0.1:3721/private' },
    { mcpDeps: deps },
  ))
  assert(privateNavigation?.ok === false
    && privateNavigation?.code === 'PRIVATE_NETWORK_BLOCKED',
    'native browser navigation applies Bailongma private-network URL policy',
    JSON.stringify(privateNavigation))
  assert(FakeClient.calls.length === beforePrivateCall,
    'blocked private-network navigation never reaches MCP client')

  const beforeBlockedCall = FakeClient.calls.length
  const blocked = parseJson(await executeBuiltInPlaywrightTool(
    'browser_evaluate',
    { function: '() => process.env' },
    { mcpDeps: deps },
  ))
  assert(blocked?.ok === false && /not allowed/.test(blocked?.error || ''),
    'internal API rejects a forbidden remote tool', JSON.stringify(blocked))
  assert(FakeClient.calls.length === beforeBlockedCall, 'forbidden remote tool never reaches MCP client')

  const connectedInteractiveClient = [...FakeClient.instances].reverse().find(client => (
    client.transport?.params?.args?.includes('--user-data-dir')
  ))
  connectedInteractiveClient.onclose?.()
  assert(listMcpTools().some(tool => tool.name === 'browser_navigate'),
    'unexpected built-in disconnect preserves the trusted native schema for recovery')
  const recovered = parseJson(await executeMcpTool(
    'browser_snapshot',
    {},
    { mcpDeps: deps },
  ))
  assert(recovered?.ok === true && FakeClient.instances.length >= 3,
    'next native call reconnects an unexpectedly closed built-in server',
    JSON.stringify(recovered))

  config.security.browserPrivateNetwork = true
  const privateResult = parseJson(await executeMcpTool(
    'browser_snapshot',
    {},
    { mcpDeps: deps },
  ))
  const latestInteractiveClient = [...FakeClient.instances].reverse().find(client => (
    client.transport?.params?.args?.includes('--user-data-dir')
  ))
  assert(privateResult?.ok === true
    && !latestInteractiveClient?.transport?.params?.args?.includes('--blocked-origins'),
    'native call reconciles the built-in process when private-network permission changes',
    JSON.stringify(privateResult))
  config.security.browserPrivateNetwork = false

  const readerResult = parseJson(await executeBuiltInPlaywrightTool(
    'browser_snapshot',
    {},
    { mode: 'reader', mcpDeps: deps },
  ))
  assert(readerResult?.ok === true && readerResult?.server_id === BUILTIN_PLAYWRIGHT_READER_ID,
    'internal API lazily starts and calls the isolated reader', JSON.stringify(readerResult))
  assert(!listMcpTools().some(tool => tool.serverId === BUILTIN_PLAYWRIGHT_READER_ID),
    'reader tools stay hidden after the reader connects')

  const status = getMcpStatus()
  assert(status.builtInPlaywright?.interactive?.status === 'connected'
    && status.builtInPlaywright?.interactive?.headed === true,
    'status identifies the connected interactive built-in server', JSON.stringify(status))
  assert(status.builtInPlaywright?.reader?.status === 'connected'
    && status.builtInPlaywright?.reader?.lazy === true,
    'status identifies the lazily connected reader server', JSON.stringify(status))

  await shutdownBuiltInPlaywright({ role: 'reader' })
  assert(getMcpStatus().builtInPlaywright?.reader?.status === 'idle',
    'reader process can be shut down independently after an internal read')
} finally {
  await shutdownMcpClients()
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (failed === 0) console.log('All built-in Playwright MCP tests passed.')
