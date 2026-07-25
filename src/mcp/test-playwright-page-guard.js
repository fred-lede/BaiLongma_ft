import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { default: installPageGuard } = require('./playwright-page-guard.cjs')
const previousPrivateNetwork = process.env.BAILONGMA_BROWSER_PRIVATE_NETWORK

function fakePage() {
  const context = {
    httpHandler: null,
    webSocketHandler: null,
    routeCalls: 0,
    webSocketRouteCalls: 0,
    async route(_pattern, handler) {
      this.routeCalls += 1
      this.httpHandler = handler
    },
    async routeWebSocket(_pattern, handler) {
      this.webSocketRouteCalls += 1
      this.webSocketHandler = handler
    },
  }
  return {
    context,
    page: { context: () => context },
  }
}

function fakeRoute(url) {
  return {
    continued: false,
    aborted: false,
    request: () => ({ url: () => url }),
    async continue() { this.continued = true },
    async abort() { this.aborted = true },
  }
}

function fakeWebSocket(url) {
  return {
    connected: false,
    closed: false,
    url: () => url,
    connectToServer() { this.connected = true },
    async close() { this.closed = true },
  }
}

try {
  process.env.BAILONGMA_BROWSER_PRIVATE_NETWORK = '0'
  const guarded = fakePage()
  await installPageGuard({ page: guarded.page })
  await installPageGuard({ page: guarded.page })
  assert.equal(guarded.context.routeCalls, 1, 'HTTP guard installs once per browser context')
  assert.equal(guarded.context.webSocketRouteCalls, 1, 'WebSocket guard installs once per browser context')

  const privateRoute = fakeRoute('http://169.254.169.254/latest/meta-data/')
  await guarded.context.httpHandler(privateRoute)
  assert.equal(privateRoute.aborted, true, 'private HTTP subrequest/redirect is aborted')
  assert.equal(privateRoute.continued, false)

  const publicRoute = fakeRoute('https://93.184.216.34/resource.js')
  await guarded.context.httpHandler(publicRoute)
  assert.equal(publicRoute.continued, true, 'public HTTP subrequest is continued')
  assert.equal(publicRoute.aborted, false)

  const privateSocket = fakeWebSocket('ws://127.0.0.1:3721/events')
  await guarded.context.webSocketHandler(privateSocket)
  assert.equal(privateSocket.closed, true, 'private WebSocket is closed')
  assert.equal(privateSocket.connected, false)

  const publicSocket = fakeWebSocket('wss://93.184.216.34/events')
  await guarded.context.webSocketHandler(publicSocket)
  assert.equal(publicSocket.connected, true, 'public WebSocket is connected')
  assert.equal(publicSocket.closed, false)

  process.env.BAILONGMA_BROWSER_PRIVATE_NETWORK = '1'
  const unrestricted = fakePage()
  await installPageGuard({ page: unrestricted.page })
  assert.equal(unrestricted.context.routeCalls, 0,
    'explicit private-network permission bypasses the request guard')
  assert.equal(unrestricted.context.webSocketRouteCalls, 0)
} finally {
  if (previousPrivateNetwork === undefined) delete process.env.BAILONGMA_BROWSER_PRIVATE_NETWORK
  else process.env.BAILONGMA_BROWSER_PRIVATE_NETWORK = previousPrivateNetwork
}

console.log('test-playwright-page-guard passed')
