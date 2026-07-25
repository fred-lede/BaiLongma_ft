import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { config } from '../config.js'
import { paths } from '../paths.js'

export const BUILTIN_PLAYWRIGHT_INTERACTIVE_ID = 'builtin_playwright'
export const BUILTIN_PLAYWRIGHT_READER_ID = 'builtin_playwright_reader'

// Keep this list deliberately small. In particular, never add JavaScript/code
// execution, file transfer, or detailed network inspection here. This is a
// product security boundary even if a future Playwright MCP release advertises
// more tools by default.
export const BUILTIN_PLAYWRIGHT_ALLOWED_TOOLS = Object.freeze([
  'browser_close',
  'browser_resize',
  'browser_console_messages',
  'browser_handle_dialog',
  'browser_find',
  'browser_fill_form',
  'browser_press_key',
  'browser_type',
  'browser_navigate',
  'browser_navigate_back',
  'browser_take_screenshot',
  'browser_snapshot',
  'browser_click',
  'browser_drag',
  'browser_hover',
  'browser_select_option',
  'browser_tabs',
  'browser_wait_for',
])

// Playwright documents this blocklist as a guardrail, not a complete network
// sandbox (notably, redirects need separate validation). It still blocks the
// most common accidental loopback access while private-network permission is
// disabled in Bailongma.
export const BUILTIN_PLAYWRIGHT_BLOCKED_ORIGINS = Object.freeze([
  'http://localhost:*',
  'https://localhost:*',
  'http://127.0.0.1:*',
  'https://127.0.0.1:*',
  'http://[::1]:*',
  'https://[::1]:*',
  'http://0.0.0.0:*',
  'https://0.0.0.0:*',
])

const ALLOWED_TOOL_SET = new Set(BUILTIN_PLAYWRIGHT_ALLOWED_TOOLS)
const require = createRequire(import.meta.url)

export function isBuiltInPlaywrightToolAllowed(name) {
  return ALLOWED_TOOL_SET.has(String(name || ''))
}

function resolveInstalledCli() {
  try {
    const packageJson = require.resolve('@playwright/mcp/package.json')
    return path.join(path.dirname(packageJson), 'cli.js')
  } catch {
    return ''
  }
}

export function resolveBuiltInPlaywrightCli({
  cliPath = process.env.BAILONGMA_PLAYWRIGHT_MCP_CLI,
  resourcesDir = paths.resourcesDir,
} = {}) {
  if (String(cliPath || '').trim()) return path.resolve(String(cliPath).trim())

  // In a packaged Electron app resourcesDir points at app.asar. Electron's
  // patched filesystem and Node mode can execute a JavaScript entry from it.
  const bundled = path.join(resourcesDir, 'node_modules', '@playwright', 'mcp', 'cli.js')
  if (fs.existsSync(bundled)) return bundled

  const installed = resolveInstalledCli()
  return installed || bundled
}

export function resolveBuiltInPlaywrightPageGuard({
  guardPath = process.env.BAILONGMA_PLAYWRIGHT_PAGE_GUARD,
  resourcesDir = paths.resourcesDir,
} = {}) {
  if (String(guardPath || '').trim()) return path.resolve(String(guardPath).trim())
  return path.join(resourcesDir, 'src', 'mcp', 'playwright-page-guard.cjs')
}

function inheritedPlaywrightEnv(source = process.env) {
  const env = {}
  for (const name of [
    'PLAYWRIGHT_BROWSERS_PATH',
    'PLAYWRIGHT_HOST_PLATFORM_OVERRIDE',
    'BAILONGMA_BUNDLED_PLAYWRIGHT',
  ]) {
    if (source[name]) env[name] = source[name]
  }
  return env
}

function ensureDirectory(directory) {
  try { fs.mkdirSync(directory, { recursive: true }) } catch {}
  return directory
}

export function createBuiltInPlaywrightServer({
  role = 'interactive',
  cliPath,
  command = process.execPath,
  resourcesDir = paths.resourcesDir,
  userDir = paths.userDir,
  sandboxDir = paths.sandboxDir,
  env = process.env,
  electronRuntime = Boolean(process.versions.electron),
  allowPrivateNetwork = config.security?.browserPrivateNetwork === true,
} = {}) {
  if (!['interactive', 'reader'].includes(role)) {
    throw new Error(`unknown built-in Playwright MCP role "${role}"`)
  }

  const isReader = role === 'reader'
  const id = isReader ? BUILTIN_PLAYWRIGHT_READER_ID : BUILTIN_PLAYWRIGHT_INTERACTIVE_ID
  const outputDir = ensureDirectory(path.join(sandboxDir, 'browser-output', role))
  const profileDir = path.join(userDir, 'browser-profiles', 'playwright-mcp-interactive')
  if (!isReader) ensureDirectory(profileDir)

  const args = [
    resolveBuiltInPlaywrightCli({ cliPath, resourcesDir }),
    '--block-service-workers',
    '--browser', 'chromium',
    '--codegen', 'none',
    '--console-level', 'warning',
    '--image-responses', 'omit',
    '--init-page', resolveBuiltInPlaywrightPageGuard({ resourcesDir }),
    '--output-dir', outputDir,
    '--output-max-size', String(50 * 1024 * 1024),
    '--output-mode', 'stdout',
    // Let official Playwright MCP attach the latest accessibility snapshot to
    // navigation/action results. callLLM already appends each tool result to
    // the next model round, so the model gets fresh refs without a routine
    // follow-up browser_snapshot call. The explicit snapshot/find tools remain
    // available for passive page changes, missing output, or targeted lookup.
    '--snapshot-mode', 'full',
    '--timeout-action', '10000',
    '--timeout-navigation', '60000',
  ]
  if (!allowPrivateNetwork) {
    args.push('--blocked-origins', BUILTIN_PLAYWRIGHT_BLOCKED_ORIGINS.join(';'))
  }
  if (isReader) args.push('--headless', '--isolated')
  else args.push('--user-data-dir', profileDir)

  return {
    id,
    name: isReader ? 'Playwright Web Reader' : 'Playwright Browser',
    enabled: true,
    transport: 'stdio',
    command,
    args,
    // MCP resolves caller-supplied relative filenames against cwd. Root it at
    // the dedicated output directory so screenshots/logs cannot spill into
    // arbitrary sandbox paths, while the directory itself remains in sandbox.
    cwd: outputDir,
    env: {
      ...inheritedPlaywrightEnv(env),
      BAILONGMA_BROWSER_PRIVATE_NETWORK: allowPrivateNetwork ? '1' : '0',
      ...(electronRuntime ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    allowedTools: [...BUILTIN_PLAYWRIGHT_ALLOWED_TOOLS],
    allowAutonomousReadOnly: false,
    timeoutMs: 90_000,
    builtIn: true,
    playwrightRole: role,
    exposeRemoteNames: !isReader,
    catalogVisible: !isReader,
    enforceAllowedTools: true,
    lazy: isReader,
    persistent: !isReader,
    headed: !isReader,
    allowPrivateNetwork,
  }
}

export function getBuiltInPlaywrightServer({
  role = 'interactive',
  ...options
} = {}) {
  return createBuiltInPlaywrightServer({ role, ...options })
}

export function getBuiltInMcpServers(options = {}) {
  return [createBuiltInPlaywrightServer({ ...options, role: 'interactive' })]
}

export const __internal = {
  inheritedPlaywrightEnv,
  resolveInstalledCli,
}
