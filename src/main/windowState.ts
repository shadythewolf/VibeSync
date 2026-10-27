/**
 * Persists the main window geometry to <userData>/window-state.json.
 *
 * Saves are debounced (400 ms) on resize/move and written atomically (tmp + rename).
 * On load the saved bounds are validated against the currently connected displays;
 * off-screen or nonsensical bounds fall back to a centred default window.
 */
import { screen, type BrowserWindow, type Rectangle } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { getWindowStatePath } from './paths'
import { log } from './logger'

export const DEFAULT_WINDOW_WIDTH = 1280
export const DEFAULT_WINDOW_HEIGHT = 800
export const MIN_WINDOW_WIDTH = 960
export const MIN_WINDOW_HEIGHT = 600

const SAVE_DEBOUNCE_MS = 400
/** Minimum visible overlap with a display work area for saved bounds to be trusted. */
const MIN_VISIBLE_W = 120
const MIN_VISIBLE_H = 80

export interface SavedWindowState {
  x: number | undefined
  y: number | undefined
  width: number
  height: number
  isMaximized: boolean
  isFullScreen: boolean
}

interface PersistedShape {
  x?: unknown
  y?: unknown
  width?: unknown
  height?: unknown
  isMaximized?: unknown
  isFullScreen?: unknown
}

function finiteInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined
}

function centredDefault(): SavedWindowState {
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.max(MIN_WINDOW_WIDTH, Math.min(DEFAULT_WINDOW_WIDTH, area.width))
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.min(DEFAULT_WINDOW_HEIGHT, area.height))
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
    isMaximized: false,
    isFullScreen: false
  }
}

function visibleOnSomeDisplay(b: Rectangle): boolean {
  for (const d of screen.getAllDisplays()) {
    const a = d.workArea
    const ox = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x)
    const oy = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y)
    if (ox >= MIN_VISIBLE_W && oy >= MIN_VISIBLE_H) return true
  }
  return false
}

/** Read and validate the saved state. Requires the `screen` module, i.e. app ready. */
export function loadWindowState(): SavedWindowState {
  const path = getWindowStatePath()
  const fallback = centredDefault()
  if (!existsSync(path)) return fallback
  let parsed: PersistedShape
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedShape
    if (typeof parsed !== 'object' || parsed === null) return fallback
  } catch (err) {
    log('warn', 'window-state.json unreadable; using default window geometry', err)
    return fallback
  }

  const width = Math.max(MIN_WINDOW_WIDTH, finiteInt(parsed.width) ?? fallback.width)
  const height = Math.max(MIN_WINDOW_HEIGHT, finiteInt(parsed.height) ?? fallback.height)
  const x = finiteInt(parsed.x)
  const y = finiteInt(parsed.y)
  const isMaximized = parsed.isMaximized === true
  const isFullScreen = parsed.isFullScreen === true

  if (x === undefined || y === undefined || !visibleOnSomeDisplay({ x, y, width, height })) {
    // Off-screen (display unplugged, resolution changed) -> centred default size, keep flags.
    const c = centredDefault()
    return { ...c, isMaximized, isFullScreen }
  }
  return { x, y, width, height, isMaximized, isFullScreen }
}

function snapshot(win: BrowserWindow): SavedWindowState {
  const isMaximized = win.isMaximized()
  const isFullScreen = win.isFullScreen()
  // Always the "normal" geometry we return to: while maximized, fullscreen or minimized
  // getBounds() reports the current (or off-screen -32000,-32000) frame instead.
  const b = win.getNormalBounds()
  return {
    x: b.x,
    y: b.y,
    width: Math.max(MIN_WINDOW_WIDTH, b.width),
    height: Math.max(MIN_WINDOW_HEIGHT, b.height),
    isMaximized,
    isFullScreen
  }
}

let lastSerialized = ''
let writeChain: Promise<void> = Promise.resolve()

function serialize(state: SavedWindowState): string {
  return JSON.stringify(state, null, 2)
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = path + '.tmp'
  await writeFile(tmp, data, 'utf8')
  await rename(tmp, path)
}

function saveAsync(state: SavedWindowState): void {
  const data = serialize(state)
  if (data === lastSerialized) return
  lastSerialized = data
  const path = getWindowStatePath()
  writeChain = writeChain
    .then(() => writeAtomic(path, data))
    .catch((err: unknown) => log('warn', 'Could not save window state', err))
}

/** Synchronous save for shutdown paths. */
export function saveWindowStateNow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  try {
    const state = snapshot(win)
    // A minimized window can still report off-screen coordinates on Windows; keep the
    // previously remembered position rather than persisting (-32000, -32000).
    if ((state.x ?? 0) < -20000 || (state.y ?? 0) < -20000) return
    const data = serialize(state)
    if (data === lastSerialized) return
    lastSerialized = data
    const path = getWindowStatePath()
    const tmp = path + '.tmp'
    writeFileSync(tmp, data, 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    log('warn', 'Could not save window state (sync)', err)
  }
}

/**
 * Track geometry changes of `win` and persist them (debounced). Returns a disposer.
 * Minimized windows are not sampled (their bounds are meaningless).
 */
export function trackWindowState(win: BrowserWindow): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    timer = null
    if (win.isDestroyed() || win.isMinimized()) return
    saveAsync(snapshot(win))
  }
  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(flush, SAVE_DEBOUNCE_MS)
  }
  const immediate = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (win.isDestroyed() || win.isMinimized()) return
    saveAsync(snapshot(win))
  }

  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', immediate)
  win.on('unmaximize', immediate)
  win.on('enter-full-screen', immediate)
  win.on('leave-full-screen', immediate)
  win.on('close', () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    saveWindowStateNow(win)
  })

  return () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (!win.isDestroyed()) {
      win.removeListener('resize', schedule)
      win.removeListener('move', schedule)
      win.removeListener('maximize', immediate)
      win.removeListener('unmaximize', immediate)
      win.removeListener('enter-full-screen', immediate)
      win.removeListener('leave-full-screen', immediate)
    }
  }
}
