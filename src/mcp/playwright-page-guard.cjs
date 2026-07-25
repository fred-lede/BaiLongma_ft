'use strict'

// Trusted Playwright MCP init-page hook. This is not an Agent-facing browser
// tool: it only restores Bailongma's request-level private-network policy for
// every page, subresource, redirect target, and WebSocket opened by the
// official MCP-managed browser context.
const INSTALLED = Symbol.for('bailongma.playwrightRequestGuardInstalled')

async function installPageGuard({ page }) {
  if (process.env.BAILONGMA_BROWSER_PRIVATE_NETWORK === '1') return

  const browserContext = page.context()
  if (browserContext[INSTALLED]) return
  browserContext[INSTALLED] = true

  const { assertWebUrlAllowed } = await import('../capabilities/tools/web/url-policy.js')

  if (typeof browserContext.routeWebSocket === 'function') {
    await browserContext.routeWebSocket('**/*', async webSocket => {
      try {
        const parsed = new URL(String(webSocket.url()))
        if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password) {
          throw new Error('unsafe WebSocket URL')
        }
        parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
        await assertWebUrlAllowed(parsed.href)
        webSocket.connectToServer()
      } catch {
        await Promise.resolve(
          webSocket.close({ code: 1008, reason: 'Blocked by Bailongma browser network policy' }),
        ).catch(() => {})
      }
    })
  }

  await browserContext.route('**/*', async route => {
    try {
      await assertWebUrlAllowed(route.request().url())
      await route.continue()
    } catch {
      await route.abort('blockedbyclient').catch(() => {})
    }
  })
}

// Playwright MCP loads init-page modules as `const { default: func } =
// require(path)`, so expose an explicit default property from CommonJS.
module.exports = { default: installPageGuard }
