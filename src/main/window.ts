/**
 * Main BrowserWindow: creation, show/hide policy, fullscreen, navigation hardening and
 * WindowState broadcasts (IPC.windowStateChanged).
 *
 * The renderer is sandboxed (contextIsolation + sandbox, no Node); the only bridge is the
 * preload at ../preload/index.js. window.open and navigation away from the app are blocked.
 */
import { app, BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC } from '../shared/ipc'
import type { WindowState } from '../shared/types'
import { log } from './logger'
import { settingsStore } from './settingsStore'
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  loadWindowState,
  trackWindowState
} from './windowState'

export const WINDOW_BACKGROUND = '#020203'
export const TITLE_BAR_SYMBOL_COLOR = '#F4F6FF'
export const TITLE_BAR_HEIGHT = 40
/** Do not auto-reload a crashed renderer more often than this. */
const CRASH_RELOAD_COOLDOWN_MS = 60_000

let mainWindow: BrowserWindow | null = null
let quitting = false
let lastCrashReload = 0
let pendingMaximize = false
let pendingFullscreen = false
let trayAvailable: () => boolean = () => false

export interface CreateWindowOptions {
  /** Keep the window hidden after load (start minimized / --hidden); a tray must exist. */
  startHidden: boolean
}

export function isQuitting(): boolean {
  return quitting
}

export function setQuitting(value: boolean): void {
  quitting = value
}

/** Lets the tray module tell us whether hiding to the tray is possible (avoids an import cycle). */
export function setTrayAvailabilityProvider(fn: () => boolean): void {
  trayAvailable = fn
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

export function devToolsEnabled(): boolean {
  return !app.isPackaged || process.env.VIBEDECK_DEVTOOLS === '1'
}

function rendererDevUrl(): string | null {
  const url = process.env.ELECTRON_RENDERER_URL
  return !app.isPackaged && url ? url : null
}

function rendererFile(): string {
  return join(__dirname, '../renderer/index.html')
}

function allowedNavigationPrefix(): string {
  const dev = rendererDevUrl()
  if (dev) {
    try {
      return new URL(dev).origin
    } catch {
      return dev
    }
  }
  return pathToFileURL(rendererFile()).href
}

export function getWindowState(win: BrowserWindow): WindowState {
  const b = win.getBounds()
  return {
    isMaximized: win.isMaximized(),
    isMinimized: win.isMinimized(),
    isFullScreen: win.isFullScreen(),
    isAlwaysOnTop: win.isAlwaysOnTop(),
    isFocused: win.isFocused(),
    isVisible: win.isVisible() && !win.isMinimized(),
    bounds: { x: b.x, y: b.y, width: b.width, height: b.height }
  }
}

export function broadcastWindowState(win: BrowserWindow, override?: Partial<WindowState>): void {
  if (win.isDestroyed()) return
  try {
    win.webContents.send(IPC.windowStateChanged, { ...getWindowState(win), ...override })
  } catch (err) {
    log('warn', 'window:state-changed broadcast failed', err)
  }
}

export function createMainWindow(opts: CreateWindowOptions): BrowserWindow {
  const existing = getMainWindow()
  if (existing) return existing

  const settings = settingsStore.get()
  const saved = loadWindowState()
  const behaviour = settings.general.fullscreenBehavior
  const wantFullscreen = behaviour === 'always' ? true : behaviour === 'never' ? false : saved.isFullScreen
  const wantMaximize = saved.isMaximized && !wantFullscreen

  const options: BrowserWindowConstructorOptions = {
    width: saved.width || DEFAULT_WINDOW_WIDTH,
    height: saved.height || DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    title: 'VibeSync',
    backgroundColor: WINDOW_BACKGROUND,
    autoHideMenuBar: true,
    alwaysOnTop: settings.general.alwaysOnTop,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: WINDOW_BACKGROUND, symbolColor: TITLE_BAR_SYMBOL_COLOR, height: TITLE_BAR_HEIGHT },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      devTools: devToolsEnabled()
    }
  }
  if (saved.x !== undefined && saved.y !== undefined) {
    options.x = saved.x
    options.y = saved.y
  }

  const win = new BrowserWindow(options)
  mainWindow = win
  pendingMaximize = false
  pendingFullscreen = false

  trackWindowState(win)
  installNavigationGuards(win)
  installStateBroadcasts(win)
  installCrashHandling(win)

  win.on('close', (event) => {
    if (quitting) return
    if (settingsStore.get().general.closeBehavior === 'tray' && trayAvailable()) {
      event.preventDefault()
      if (win.isFullScreen()) win.setFullScreen(false)
      win.hide()
      log('info', 'Window hidden to the tray')
    }
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    if (opts.startHidden && trayAvailable()) {
      // Stay hidden; maximize()/setFullScreen() would reveal the window on Windows, so defer.
      pendingMaximize = wantMaximize
      pendingFullscreen = wantFullscreen
      log('info', 'Window kept hidden (start minimized)')
      return
    }
    if (wantMaximize) win.maximize()
    if (wantFullscreen) win.setFullScreen(true)
    if (opts.startHidden) {
      win.showInactive()
      win.minimize()
      log('info', 'Window started minimized (no tray available)')
    } else {
      win.show()
    }
    broadcastWindowState(win)
  })

  const devUrl = rendererDevUrl()
  const load = devUrl ? win.loadURL(devUrl) : win.loadFile(rendererFile())
  load.catch((err: unknown) => log('error', 'Failed to load the renderer', err))
  log('info', `Main window created (${options.width}x${options.height}${wantFullscreen ? ', fullscreen' : ''}${wantMaximize ? ', maximized' : ''})`)
  return win
}

/** Restore/show/focus the main window, recreating it when it was destroyed. */
export function showMainWindow(): void {
  let win = getMainWindow()
  if (!win) {
    win = createMainWindow({ startHidden: false })
    return
  }
  if (pendingMaximize) {
    pendingMaximize = false
    win.maximize()
  }
  if (pendingFullscreen) {
    pendingFullscreen = false
    win.setFullScreen(true)
  }
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

export function setFullscreen(win: BrowserWindow, fullscreen: boolean): void {
  if (win.isDestroyed() || win.isFullScreen() === fullscreen) return
  win.setFullScreen(fullscreen)
}

export function toggleFullscreen(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false
  const next = !win.isFullScreen()
  win.setFullScreen(next)
  return next
}

export function toggleMaximize(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
}

export function applyAlwaysOnTop(alwaysOnTop: boolean): void {
  const win = getMainWindow()
  if (!win || win.isAlwaysOnTop() === alwaysOnTop) return
  win.setAlwaysOnTop(alwaysOnTop, 'floating')
  log('info', `Always on top ${alwaysOnTop ? 'enabled' : 'disabled'}`)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function installNavigationGuards(win: BrowserWindow): void {
  const prefix = allowedNavigationPrefix()
  const allowed = (url: string): boolean => url.startsWith(prefix)
  const wc = win.webContents
  wc.setWindowOpenHandler(({ url }) => {
    log('warn', 'Blocked window.open from the renderer', url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, url) => {
    if (allowed(url)) return
    event.preventDefault()
    log('warn', 'Blocked navigation from the renderer', url)
  })
  wc.on('will-redirect', (event, url) => {
    if (allowed(url)) return
    event.preventDefault()
    log('warn', 'Blocked redirect from the renderer', url)
  })
  wc.on('will-attach-webview', (event) => {
    event.preventDefault()
    log('warn', 'Blocked <webview> attachment')
  })
}

function installStateBroadcasts(win: BrowserWindow): void {
  const send = (): void => broadcastWindowState(win)
  win.on('maximize', send)
  win.on('unmaximize', send)
  win.on('minimize', send)
  win.on('restore', send)
  // On Windows these events fire before win.isFullScreen() reflects the new state, so pass
  // the known value explicitly and re-sync shortly after.
  const sendFullscreen = (isFullScreen: boolean) => (): void => {
    broadcastWindowState(win, { isFullScreen })
    setTimeout(() => {
      if (!win.isDestroyed()) broadcastWindowState(win)
    }, 120)
  }
  win.on('enter-full-screen', sendFullscreen(true))
  win.on('leave-full-screen', sendFullscreen(false))
  win.on('focus', send)
  win.on('blur', send)
  win.on('always-on-top-changed', send)
  win.on('show', send)
  win.on('hide', send)
  win.webContents.on('did-finish-load', send)
}

function installCrashHandling(win: BrowserWindow): void {
  const wc = win.webContents
  wc.on('render-process-gone', (_event, details) => {
    log('error', `Renderer process gone: ${details.reason} (exit code ${details.exitCode})`)
    if (details.reason === 'clean-exit' || details.reason === 'killed') return
    const now = Date.now()
    if (now - lastCrashReload < CRASH_RELOAD_COOLDOWN_MS) {
      log('error', 'Renderer crashed again within the cooldown window; not reloading automatically')
      return
    }
    lastCrashReload = now
    setTimeout(() => {
      if (win.isDestroyed()) return
      log('info', 'Reloading the renderer after a crash')
      win.webContents.reload()
    }, 500)
  })
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED: superseded navigation */) return
    log('error', `Renderer failed to load (${code} ${description})`, url)
  })
  wc.on('console-message', (event) => {
    if (event.level !== 'warning' && event.level !== 'error') return
    const where = event.sourceId ? ` (${event.sourceId}:${event.lineNumber})` : ''
    log(event.level === 'error' ? 'error' : 'warn', `[renderer:console] ${event.message}${where}`)
  })
  win.on('unresponsive', () => log('warn', 'Renderer became unresponsive'))
  win.on('responsive', () => log('info', 'Renderer is responsive again'))
}
