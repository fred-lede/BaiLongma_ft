'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const {
  BROWSER_EMBED_PARTITION,
  createBrowserEmbedHost,
  isAllowedWebUrl,
  normalizeBounds,
} = require('./browser-embed-host.cjs')

class FakeSession extends EventEmitter {
  setPermissionRequestHandler(handler) { this.permissionRequestHandler = handler }
  setPermissionCheckHandler(handler) { this.permissionCheckHandler = handler }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super()
    this.id = 42
    this.session = new FakeSession()
    this.url = ''
    this.loadCalls = []
    this.destroyed = false
  }

  setWindowOpenHandler(handler) { this.windowOpenHandler = handler }
  isDestroyed() { return this.destroyed }
  getURL() { return this.url }
  async loadURL(url) {
    this.loadCalls.push(url)
    this.url = url
    this.emit('did-navigate', {}, url)
    this.emit('did-stop-loading')
  }
  setZoomFactor(value) { this.zoomFactor = value }
  close() { this.destroyed = true }
}

class FakeView {
  constructor() {
    this.visible = true
    this.bounds = null
    this.radius = null
    this.background = null
  }

  setVisible(value) { this.visible = value }
  setBounds(value) { this.bounds = { ...value } }
  setBorderRadius(value) { this.radius = value }
  setBackgroundColor(value) { this.background = value }
}

class FakeWebContentsView extends FakeView {
  static instances = []

  constructor(options) {
    super()
    this.options = options
    this.webContents = new FakeWebContents()
    FakeWebContentsView.instances.push(this)
  }
}

class FakeContentView {
  constructor() { this.children = [] }
  addChildView(view) {
    if (!this.children.includes(view)) this.children.push(view)
  }
  removeChildView(view) {
    this.children = this.children.filter(child => child !== view)
  }
}

class FakeWindow extends EventEmitter {
  constructor({ width = 1000, height = 700, show = false } = {}) {
    super()
    this.contentView = new FakeContentView()
    this.contentBounds = { x: 0, y: 0, width, height }
    this.visible = show
    this.destroyed = false
  }

  getContentBounds() { return { ...this.contentBounds } }
  isDestroyed() { return this.destroyed }
  show() { this.visible = true }
  hide() { this.visible = false }
  focus() {}
  destroy() {
    this.destroyed = true
    this.emit('closed')
  }
}

class FakeBaseWindow extends FakeWindow {
  static instances = []

  constructor(options) {
    super(options)
    this.options = options
    FakeBaseWindow.instances.push(this)
  }
}

async function run() {
  assert.equal(isAllowedWebUrl('https://example.com/path'), true)
  assert.equal(isAllowedWebUrl('http://127.0.0.1:3721/'), true)
  assert.equal(isAllowedWebUrl('file:///tmp/private'), false)
  assert.equal(isAllowedWebUrl('javascript:alert(1)'), false)
  assert.deepEqual(
    normalizeBounds({ x: 10.25, y: 20.5, width: 300.25, height: 200 }, { width: 1000, height: 700 }),
    { x: 10, y: 20, width: 301, height: 201 },
  )
  assert.deepEqual(
    normalizeBounds({ x: 900, y: 0, width: 103, height: 100 }, { width: 1000, height: 700 }),
    { x: 900, y: 0, width: 103, height: 100 },
    'a card transition may move a bounded native view beyond the right edge',
  )
  assert.throws(
    () => normalizeBounds({ x: 1003, y: 0, width: 100, height: 100 }, { width: 1000, height: 700 }),
    /transition budget/,
  )
  assert.deepEqual(
    normalizeBounds({ x: 0, y: 0, width: 1001.5, height: 701.5 }, { width: 1000, height: 700 }),
    { x: 0, y: 0, width: 1002, height: 702 },
    'sub-pixel zoom rounding may retain the transition tolerance outside the native bounds',
  )

  const warnings = []
  const host = createBrowserEmbedHost({
    WebContentsView: FakeWebContentsView,
    View: FakeView,
    BaseWindow: FakeBaseWindow,
    logger: { warn: (...args) => warnings.push(args) },
  })
  const mainWindow = new FakeWindow()
  const primedState = await host.prime(mainWindow)
  assert.equal(primedState.visible, false)
  assert.equal(primedState.webContentsId, 42)
  assert.equal(primedState.zoomFactor, 1)
  assert.deepEqual(
    FakeWebContentsView.instances[0].webContents.loadCalls,
    ['about:blank'],
    'prime must commit a renderer before Playwright attaches over CDP',
  )
  const cardState = await host.update(mainWindow, {
    mode: 'card',
    visible: true,
    bounds: { x: 20, y: 30, width: 640, height: 360 },
    radius: 20,
    url: 'https://example.com',
    interactive: false,
  })

  assert.equal(FakeWebContentsView.instances.length, 1)
  const view = FakeWebContentsView.instances[0]
  assert.equal(view.options.webPreferences.partition, BROWSER_EMBED_PARTITION)
  assert.equal(view.options.webPreferences.sandbox, true)
  assert.equal(view.options.webPreferences.nodeIntegration, false)
  assert.equal(view.options.webPreferences.contextIsolation, true)
  assert.equal(Object.hasOwn(view.options.webPreferences, 'preload'), false)
  assert.deepEqual(cardState.bounds, { x: 20, y: 30, width: 640, height: 360 })
  assert.equal(cardState.mode, 'card')
  assert.equal(cardState.url, 'https://example.com/')
  assert.equal(cardState.zoomFactor, 0.5)
  assert.equal(view.webContents.zoomFactor, 0.5)
  assert.equal(view.visible, true)
  assert.equal(view.radius, 20)
  assert.equal(mainWindow.contentView.children[0], view)
  assert.equal(mainWindow.contentView.children[1].visible, true)

  assert.deepEqual(view.webContents.windowOpenHandler({ url: 'https://example.org' }), { action: 'deny' })
  assert.equal(view.webContents.session.permissionCheckHandler(), false)
  let permissionResult = true
  view.webContents.session.permissionRequestHandler(null, 'geolocation', result => { permissionResult = result })
  assert.equal(permissionResult, false)
  let downloadPrevented = false
  let downloadCancelled = false
  view.webContents.session.emit(
    'will-download',
    { preventDefault: () => { downloadPrevented = true } },
    { cancel: () => { downloadCancelled = true } },
  )
  assert.equal(downloadPrevented, true)
  assert.equal(downloadCancelled, true)
  let navigationPrevented = false
  view.webContents.emit('will-navigate', {
    url: 'file:///etc/passwd',
    preventDefault: () => { navigationPrevented = true },
  })
  assert.equal(navigationPrevented, true)

  const target = host.getTarget()
  assert.deepEqual(target, {
    webContentsId: 42,
    partition: BROWSER_EMBED_PARTITION,
    url: 'https://example.com/',
    mode: 'card',
    visible: true,
  })

  await host.update(mainWindow, {
    mode: 'card',
    visible: true,
    bounds: { x: 25, y: 35, width: 600, height: 340 },
    radius: 18,
    url: 'https://example.com',
    interactive: true,
  })
  assert.equal(view.webContents.loadCalls.length, 2, 'layout updates must not reload the page')
  assert.equal(mainWindow.contentView.children[1].visible, false, 'interactive mode removes the input shield')

  view.webContents.url = 'https://example.org/after-playwright'
  view.webContents.emit('did-navigate', {}, view.webContents.url)
  await host.update(mainWindow, {
    mode: 'card',
    visible: true,
    bounds: { x: 25, y: 35, width: 600, height: 340 },
    radius: 18,
    url: 'https://example.org/after-playwright',
    interactive: true,
  })
  assert.equal(view.webContents.loadCalls.length, 2, 'Playwright navigation must not be loaded a second time')

  const windowState = await host.update(mainWindow, {
    mode: 'window',
    visible: true,
    radius: 99,
    interactive: true,
  })
  assert.equal(FakeWebContentsView.instances.length, 1, 'large mode must reuse the same WebContentsView')
  assert.equal(FakeBaseWindow.instances.length, 1)
  assert.equal(mainWindow.contentView.children.includes(view), false)
  assert.equal(FakeBaseWindow.instances[0].contentView.children[0], view)
  assert.equal(FakeBaseWindow.instances[0].visible, true)
  assert.equal(windowState.mode, 'window')
  assert.equal(windowState.radius, 0)
  assert.equal(windowState.zoomFactor, 1)
  assert.equal(view.webContents.zoomFactor, 1)

  await host.update(mainWindow, {
    mode: 'card',
    visible: true,
    bounds: { x: 0, y: 0, width: 500, height: 300 },
    radius: 16,
    interactive: false,
  })
  assert.equal(FakeWebContentsView.instances.length, 1)
  assert.equal(mainWindow.contentView.children[0], view)
  assert.equal(FakeBaseWindow.instances[0].visible, false)
  assert.equal(view.webContents.zoomFactor, 500 / 1280)

  const replacementWindow = new FakeWindow()
  assert.equal(host.transferMainWindow(mainWindow, replacementWindow), true)
  assert.equal(replacementWindow.contentView.children[0], view)
  assert.equal(FakeWebContentsView.instances.length, 1)

  await assert.rejects(
    host.update(mainWindow, {
      mode: 'card',
      visible: true,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
      url: 'file:///tmp/not-allowed',
    }),
    /http/,
  )
  await assert.rejects(
    host.update(mainWindow, {
      mode: 'floating',
      visible: true,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    }),
    /mode/,
  )

  host.hide(replacementWindow)
  assert.equal(host.getState(replacementWindow).visible, false)
  host.releaseWindow(replacementWindow)
  assert.equal(view.webContents.destroyed, false, 'closing the main window must preserve the MCP target')
  assert.equal(host.getTarget().webContentsId, 42)

  const reopenedWindow = new FakeWindow()
  const reopenedState = await host.prime(reopenedWindow)
  assert.equal(reopenedState.webContentsId, 42)
  assert.equal(FakeWebContentsView.instances.length, 1, 'reopening must reattach the existing WebContentsView')
  assert.equal(reopenedWindow.contentView.children[0], view)

  host.destroyAll()
  assert.equal(view.webContents.destroyed, true)
  assert.equal(host.getTarget(), null)
  assert.equal(warnings.length, 0)

  console.log('browser embed host tests passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
