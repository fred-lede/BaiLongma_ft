'use strict'

const BROWSER_EMBED_PARTITION = 'persist:bailongma-browser'
const configuredSessions = new WeakSet()

function isAllowedWebUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeWebUrl(value) {
  if (!isAllowedWebUrl(value)) {
    throw new TypeError('browser embed URL must use http:// or https://')
  }
  return new URL(value).href
}

function finiteNonNegative(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`)
  }
  return value
}

function normalizeBounds(value, contentBounds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('browser embed bounds are required')
  }

  const x = finiteNonNegative(value.x, 'bounds.x')
  const y = finiteNonNegative(value.y, 'bounds.y')
  const width = finiteNonNegative(value.width, 'bounds.width')
  const height = finiteNonNegative(value.height, 'bounds.height')
  const contentWidth = finiteNonNegative(contentBounds?.width, 'window width')
  const contentHeight = finiteNonNegative(contentBounds?.height, 'window height')
  const roundingTolerance = 2

  // Horizontal card transitions intentionally begin just beyond the right
  // edge. Electron clips child Views to the BaseWindow, so allow one viewport
  // of controlled overflow while still rejecting oversized or unbounded IPC
  // geometry. This lets the live WebContentsView move with its DOM bezel.
  if (
    x > contentWidth + roundingTolerance
    || y > contentHeight + roundingTolerance
    || width > contentWidth + roundingTolerance
    || height > contentHeight + roundingTolerance
  ) {
    throw new RangeError('browser embed bounds exceed the main window transition budget')
  }

  // DOM rectangles can contain sub-pixel values while native Views use device-
  // independent integer pixels. Expand to the surrounding pixel so no web content
  // leaks beyond the renderer-provided rectangle because of independent rounding.
  const left = Math.floor(x)
  const top = Math.floor(y)
  const right = Math.ceil(x + width)
  const bottom = Math.ceil(y + height)
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  }
}

function configureIsolatedSession(targetSession) {
  if (!targetSession || configuredSessions.has(targetSession)) return
  configuredSessions.add(targetSession)

  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  targetSession.setPermissionCheckHandler(() => false)
  targetSession.on('will-download', (event, item) => {
    event.preventDefault()
    try { item?.cancel() } catch {}
  })
}

function navigationUrl(event, legacyUrl) {
  return typeof event?.url === 'string' ? event.url : legacyUrl
}

function blockUnsafeNavigation(event, legacyUrl) {
  const url = navigationUrl(event, legacyUrl)
  // A newly-created WebContentsView starts without a committed renderer. An
  // explicit about:blank navigation is the minimal bootstrap needed before a
  // CDP client can reliably attach. Keep every other non-web scheme blocked.
  if (url && url !== 'about:blank' && !isAllowedWebUrl(url)) event.preventDefault()
}

function createBrowserEmbedHost({
  WebContentsView,
  View,
  BaseWindow,
  isAppQuitting = () => false,
  logger = console,
} = {}) {
  if (typeof WebContentsView !== 'function') {
    throw new TypeError('WebContentsView constructor is required')
  }

  let mainOwnerWindow = null
  let currentParentWindow = null
  let externalWindow = null
  let browserView = null
  let inputShield = null
  let rendererReadyPromise = null
  let requestedUrl = null
  const state = {
    available: true,
    attached: false,
    visible: false,
    mode: 'card',
    bounds: null,
    radius: 0,
    url: null,
    interactive: false,
    zoomFactor: 1,
    loading: false,
    error: null,
  }

  function snapshot() {
    const contents = browserView?.webContents
    return {
      ...state,
      bounds: state.bounds ? { ...state.bounds } : null,
      webContentsId: contents && !contents.isDestroyed() ? contents.id : null,
      partition: BROWSER_EMBED_PARTITION,
    }
  }

  function setViewVisibility(visible) {
    browserView?.setVisible(Boolean(visible))
    inputShield?.setVisible(Boolean(visible && !state.interactive))
  }

  function applyExternalBounds() {
    if (!externalWindow || externalWindow.isDestroyed() || state.mode !== 'window') return
    const content = externalWindow.getContentBounds()
    const bounds = { x: 0, y: 0, width: content.width, height: content.height }
    state.bounds = bounds
    browserView?.setBounds(bounds)
    browserView?.setBorderRadius(0)
    if (inputShield) {
      inputShield.setBounds(bounds)
      inputShield.setBorderRadius(0)
    }
  }

  function createView() {
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_EMBED_PARTITION,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
        webviewTag: false,
        plugins: false,
      },
    })
    const contents = view.webContents
    configureIsolatedSession(contents.session)

    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-frame-navigate', blockUnsafeNavigation)
    contents.on('will-navigate', blockUnsafeNavigation)
    contents.on('will-redirect', blockUnsafeNavigation)
    contents.on('before-input-event', event => {
      if (!state.interactive) event.preventDefault()
    })
    contents.on('did-start-loading', () => {
      state.loading = true
      state.error = null
    })
    contents.on('did-stop-loading', () => {
      state.loading = false
      const currentUrl = contents.getURL()
      if (isAllowedWebUrl(currentUrl)) {
        state.url = currentUrl
        requestedUrl = currentUrl
      }
    })
    contents.on('did-navigate', (_event, url) => {
      if (isAllowedWebUrl(url)) {
        state.url = url
        requestedUrl = url
      }
    })
    contents.on('did-navigate-in-page', (_event, url) => {
      if (isAllowedWebUrl(url)) {
        state.url = url
        requestedUrl = url
      }
    })
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (isMainFrame === false || errorCode === -3) return
      state.loading = false
      state.error = {
        code: Number(errorCode) || 0,
        message: String(errorDescription || 'page load failed'),
        url: isAllowedWebUrl(validatedUrl) ? validatedUrl : state.url,
      }
    })
    contents.on('render-process-gone', (_event, details) => {
      state.loading = false
      state.error = {
        code: 0,
        message: `embedded browser renderer exited: ${details?.reason || 'unknown'}`,
        url: state.url,
      }
    })

    view.setVisible(false)
    return view
  }

  function createInputShield() {
    if (typeof View !== 'function') return null
    const shield = new View()
    shield.setBackgroundColor('#00000000')
    shield.setVisible(false)
    return shield
  }

  function removeFromCurrentParent() {
    if (currentParentWindow && !currentParentWindow.isDestroyed()) {
      try {
        if (inputShield) currentParentWindow.contentView.removeChildView(inputShield)
        if (browserView) currentParentWindow.contentView.removeChildView(browserView)
      } catch {}
    }
    currentParentWindow = null
    state.attached = false
  }

  function detachFromOwner({ closeContents = false } = {}) {
    removeFromCurrentParent()
    state.visible = false
    setViewVisibility(false)
    if (externalWindow && !externalWindow.isDestroyed()) externalWindow.hide()
    if (closeContents && browserView?.webContents && !browserView.webContents.isDestroyed()) {
      try { browserView.webContents.close() } catch {}
    }
    if (closeContents) {
      browserView = null
      inputShield = null
      rendererReadyPromise = null
      requestedUrl = null
      state.bounds = null
      state.url = null
      state.loading = false
      state.error = null
    }
    mainOwnerWindow = null
  }

  function ensureView(targetWindow) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      throw new Error('main window is unavailable')
    }
    if (mainOwnerWindow && mainOwnerWindow !== targetWindow) detachFromOwner()
    mainOwnerWindow = targetWindow
    if (!browserView || browserView.webContents.isDestroyed()) {
      browserView = createView()
      inputShield = createInputShield()
    }
  }

  async function ensureRendererReady() {
    const contents = browserView?.webContents
    if (!contents || contents.isDestroyed()) {
      throw new Error('embedded browser renderer is unavailable')
    }
    if (contents.getURL()) return
    if (!rendererReadyPromise) {
      rendererReadyPromise = contents.loadURL('about:blank').catch(error => {
        state.loading = false
        state.error = {
          code: 0,
          message: error?.message || String(error),
          url: null,
        }
        throw error
      }).finally(() => {
        rendererReadyPromise = null
      })
    }
    await rendererReadyPromise
  }

  function attachTo(targetWindow) {
    if (currentParentWindow === targetWindow) return
    removeFromCurrentParent()
    targetWindow.contentView.addChildView(browserView)
    if (inputShield) targetWindow.contentView.addChildView(inputShield)
    currentParentWindow = targetWindow
    state.attached = true
  }

  async function prime(targetWindow) {
    ensureView(targetWindow)
    state.mode = 'card'
    state.visible = false
    state.bounds = { x: 0, y: 0, width: 1, height: 1 }
    state.radius = 0
    state.interactive = false
    state.zoomFactor = 1
    attachTo(targetWindow)
    browserView.setBounds(state.bounds)
    browserView.setBorderRadius(0)
    browserView.webContents.setZoomFactor(1)
    if (inputShield) {
      inputShield.setBounds(state.bounds)
      inputShield.setBorderRadius(0)
    }
    setViewVisibility(false)
    await ensureRendererReady()
    return snapshot()
  }

  function transferMainWindow(fromWindow, toWindow) {
    if (mainOwnerWindow !== fromWindow || !toWindow || toWindow.isDestroyed()) return false
    mainOwnerWindow = toWindow
    if (currentParentWindow === fromWindow) attachTo(toWindow)
    return true
  }

  function ensureExternalWindow() {
    if (externalWindow && !externalWindow.isDestroyed()) return externalWindow
    if (typeof BaseWindow !== 'function') {
      throw new Error('large embedded browser window is unavailable')
    }
    externalWindow = new BaseWindow({
      width: 1280,
      height: 840,
      minWidth: 480,
      minHeight: 360,
      show: false,
      title: 'Bailongma Browser',
      backgroundColor: '#000000',
    })
    const hostWindow = externalWindow
    hostWindow.on('resize', applyExternalBounds)
    hostWindow.on('close', event => {
      if (isAppQuitting()) return
      event.preventDefault()
      hostWindow.hide()
      state.visible = false
      setViewVisibility(false)
    })
    hostWindow.on('closed', () => {
      if (currentParentWindow === hostWindow) {
        currentParentWindow = null
        state.attached = false
      }
      if (externalWindow === hostWindow) externalWindow = null
    })
    return hostWindow
  }

  async function update(targetWindow, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('browser embed update options must be an object')
    }
    if (typeof options.visible !== 'boolean') {
      throw new TypeError('browser embed visible must be a boolean')
    }
    if (options.interactive != null && typeof options.interactive !== 'boolean') {
      throw new TypeError('browser embed interactive must be a boolean')
    }

    const mode = options.mode == null ? 'card' : options.mode
    if (mode !== 'card' && mode !== 'window') {
      throw new TypeError('browser embed mode must be "card" or "window"')
    }
    const bounds = mode === 'card'
      ? normalizeBounds(options.bounds, targetWindow?.getContentBounds?.())
      : null
    const radius = finiteNonNegative(options.radius ?? 0, 'browser embed radius')
    const nextUrl = options.url == null ? null : normalizeWebUrl(options.url)

    ensureView(targetWindow)
    await ensureRendererReady()
    state.mode = mode
    state.interactive = options.interactive === true
    if (mode === 'window') {
      const windowHost = ensureExternalWindow()
      attachTo(windowHost)
      state.radius = 0
      state.zoomFactor = 1
      browserView.webContents.setZoomFactor(1)
      applyExternalBounds()
      state.visible = options.visible && state.bounds.width > 0 && state.bounds.height > 0
      setViewVisibility(state.visible)
      if (state.visible) {
        windowHost.show()
        windowHost.focus()
      } else {
        windowHost.hide()
      }
    } else {
      if (externalWindow && !externalWindow.isDestroyed()) externalWindow.hide()
      attachTo(targetWindow)
      state.bounds = bounds
      state.radius = Math.min(radius, bounds.width / 2, bounds.height / 2)
      state.zoomFactor = bounds.width > 0 ? Math.min(1, bounds.width / 1280) : 1
      state.visible = options.visible && bounds.width > 0 && bounds.height > 0
      browserView.setBounds(bounds)
      browserView.setBorderRadius(state.radius)
      browserView.webContents.setZoomFactor(state.zoomFactor)
      if (inputShield) {
        inputShield.setBounds(bounds)
        inputShield.setBorderRadius(state.radius)
      }
      setViewVisibility(state.visible)
    }

    if (nextUrl && nextUrl !== requestedUrl) {
      requestedUrl = nextUrl
      state.url = nextUrl
      state.loading = true
      state.error = null
      try {
        await browserView.webContents.loadURL(nextUrl)
      } catch (error) {
        state.loading = false
        state.error ||= {
          code: 0,
          message: error?.message || String(error),
          url: nextUrl,
        }
        logger.warn?.('[browser-embed] load failed:', state.error.message)
      }
    }

    return snapshot()
  }

  function hide(targetWindow) {
    if (mainOwnerWindow && mainOwnerWindow !== targetWindow) {
      throw new Error('embedded browser belongs to another window')
    }
    state.visible = false
    setViewVisibility(false)
    if (externalWindow && !externalWindow.isDestroyed()) externalWindow.hide()
    return snapshot()
  }

  function getState(targetWindow) {
    if (mainOwnerWindow && mainOwnerWindow !== targetWindow) {
      throw new Error('embedded browser belongs to another window')
    }
    return snapshot()
  }

  function releaseWindow(targetWindow) {
    if (mainOwnerWindow !== targetWindow) return
    detachFromOwner()
  }

  function destroyAll() {
    detachFromOwner({ closeContents: true })
    if (externalWindow && !externalWindow.isDestroyed()) {
      try { externalWindow.destroy() } catch {}
    }
    externalWindow = null
  }

  function getTarget() {
    const contents = browserView?.webContents
    if (!contents || contents.isDestroyed()) return null
    return Object.freeze({
      webContentsId: contents.id,
      partition: BROWSER_EMBED_PARTITION,
      url: isAllowedWebUrl(contents.getURL()) ? contents.getURL() : state.url,
      mode: state.mode,
      visible: state.visible,
    })
  }

  return {
    update,
    prime,
    transferMainWindow,
    hide,
    getState,
    releaseWindow,
    destroyAll,
    getTarget,
  }
}

module.exports = {
  BROWSER_EMBED_PARTITION,
  createBrowserEmbedHost,
  isAllowedWebUrl,
  normalizeBounds,
}
