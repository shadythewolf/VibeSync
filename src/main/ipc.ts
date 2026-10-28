/**
 * IPC surface of the main process - one handler per channel in src/shared/ipc.ts.
 *
 * Every payload coming from the renderer is validated before use: the renderer is
 * sandboxed but a compromised page must not be able to open arbitrary URLs, write
 * arbitrary settings or crash the main process with a malformed argument.
 */
import { app, BrowserWindow, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import * as os from 'node:os'
import { IPC } from '../shared/ipc'
import { CAPTURE_ENGINES, type CaptureEngine, type DeepPartial, type Settings } from '../shared/settings'
import type { AppInfo, BrowserCaptureReport, LogLevel } from '../shared/types'
import type { AudioService } from './audioService'
import { getBridgeSetupStatus, installBridge } from './bridgeInstaller'
import { isErrorCode } from './errors'
import { getLogDir, getLogPath, log } from './logger'
import type { MetadataService } from './metadataService'
import type { LyricsService } from './lyricsService'
import { getHelperPath, getUserDataPath, helperExists, isPortable } from './paths'
import { settingsStore } from './settingsStore'
import { isHardwareAccelerationEnabled, wasGpuFallbackApplied } from './gpuGuard'
import { checkForUpdates, downloadUpdate, getUpdateState, installUpdate, updatesConfigured } from './updater'
import { getMainWindow, getWindowState, setFullscreen, setQuitting, toggleFullscreen, toggleMaximize } from './window'

export interface IpcServices {
  audio: AudioService
  metadata: MetadataService
  lyrics: LyricsService
}

const MAX_URL_LENGTH = 2048
const MAX_LOG_MESSAGE = 4000
const MAX_LOG_DETAIL = 16000
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

let registered = false

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function clampString(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  return v.length > max ? v.slice(0, max) + '…' : v
}

function isCaptureEngine(v: unknown): v is CaptureEngine {
  return typeof v === 'string' && (CAPTURE_ENGINES as readonly string[]).includes(v)
}

function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && (LOG_LEVELS as readonly string[]).includes(v)
}

/** Only web contents that belong to one of our BrowserWindows may talk to us. */
function senderWindow(event: IpcMainInvokeEvent | IpcMainEvent): BrowserWindow | null {
  try {
    return BrowserWindow.fromWebContents(event.sender)
  } catch {
    return null
  }
}

function requireTrusted(event: IpcMainInvokeEvent | IpcMainEvent, channel: string): BrowserWindow {
  const win = senderWindow(event)
  if (!win) {
    log('warn', `Rejected IPC '${channel}' from an unknown sender`)
    throw new Error('Untrusted IPC sender')
  }
  return win
}

function targetWindow(event: IpcMainInvokeEvent | IpcMainEvent): BrowserWindow | null {
  const win = senderWindow(event)
  if (win && !win.isDestroyed()) return win
  return getMainWindow()
}

function sanitizeBrowserReport(raw: unknown): BrowserCaptureReport | null {
  if (!isPlainObject(raw)) return null
  const state = raw.state
  if (state !== 'starting' && state !== 'connected' && state !== 'error' && state !== 'stopped') return null
  const report: BrowserCaptureReport = { state }
  if (typeof raw.sampleRate === 'number' && Number.isFinite(raw.sampleRate) && raw.sampleRate > 0) report.sampleRate = raw.sampleRate
  if (typeof raw.channels === 'number' && Number.isFinite(raw.channels) && raw.channels > 0) report.channels = raw.channels
  if (isPlainObject(raw.error) && isErrorCode(raw.error.code) && typeof raw.error.message === 'string') {
    report.error = {
      code: raw.error.code,
      message: raw.error.message.slice(0, 500),
      hint: clampString(raw.error.hint, 500),
      detail: clampString(raw.error.detail, 4000)
    }
  }
  return report
}

function parseExternalUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) throw new Error('Invalid URL')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Invalid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) links can be opened')
  return url.href
}

function buildAppInfo(): AppInfo {
  let osVersion = `${os.type()} ${os.release()}`
  try {
    const friendly = os.version()
    if (friendly) osVersion = `${friendly} (${os.release()})`
  } catch {
    /* os.version() is unavailable on very old Node builds */
  }
  return {
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osVersion,
    userDataPath: getUserDataPath(),
    logPath: getLogPath(),
    helperPath: getHelperPath(),
    helperFound: helperExists(),
    isPackaged: app.isPackaged,
    isPortable,
    updatesConfigured: updatesConfigured(),
    hardwareAcceleration: isHardwareAccelerationEnabled(),
    gpuFallbackApplied: wasGpuFallbackApplied()
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerIpc(services: IpcServices): void {
  if (registered) return
  registered = true
  const { audio, metadata } = services

  // ----- settings ----------------------------------------------------------
  ipcMain.handle(IPC.settingsGet, (event) => {
    requireTrusted(event, IPC.settingsGet)
    return settingsStore.get()
  })
  ipcMain.handle(IPC.settingsSet, (event, patch: unknown) => {
    requireTrusted(event, IPC.settingsSet)
    if (!isPlainObject(patch)) throw new TypeError('settings.set expects an object')
    // mergeSettings/validateSettings coerce every field, so the cast is safe.
    return settingsStore.set(patch as DeepPartial<Settings>)
  })
  ipcMain.handle(IPC.settingsReset, (event) => {
    requireTrusted(event, IPC.settingsReset)
    return settingsStore.reset()
  })

  // ----- audio -------------------------------------------------------------
  ipcMain.handle(IPC.audioGetStatus, (event) => {
    requireTrusted(event, IPC.audioGetStatus)
    return audio.getStatus()
  })
  ipcMain.handle(IPC.audioListDevices, (event) => {
    requireTrusted(event, IPC.audioListDevices)
    return audio.listDevices()
  })
  ipcMain.handle(IPC.audioSelectDevice, (event, deviceId: unknown) => {
    requireTrusted(event, IPC.audioSelectDevice)
    if (deviceId !== null && typeof deviceId !== 'string') throw new TypeError('deviceId must be a string or null')
    if (typeof deviceId === 'string' && deviceId.length >= 512) throw new TypeError('deviceId is too long')
    return audio.selectDevice(deviceId)
  })
  ipcMain.handle(IPC.audioSetEngine, (event, engine: unknown) => {
    requireTrusted(event, IPC.audioSetEngine)
    if (!isCaptureEngine(engine)) throw new TypeError(`Unknown capture engine: ${String(engine)}`)
    return audio.setEngine(engine)
  })
  ipcMain.handle(IPC.audioRestart, (event) => {
    requireTrusted(event, IPC.audioRestart)
    return audio.restart()
  })
  ipcMain.on(IPC.audioBrowserReport, (event, raw: unknown) => {
    if (!senderWindow(event)) return
    const report = sanitizeBrowserReport(raw)
    if (!report) {
      log('warn', 'Ignored malformed browser capture report', raw)
      return
    }
    audio.handleBrowserReport(report)
  })

  // ----- track -------------------------------------------------------------
  ipcMain.handle(IPC.lyricsGet, (event) => {
    requireTrusted(event, IPC.lyricsGet)
    return services.lyrics.getState()
  })

  ipcMain.handle(IPC.trackGet, (event) => {
    requireTrusted(event, IPC.trackGet)
    return metadata.getTrack()
  })

  // ----- Spotify -----------------------------------------------------------
  ipcMain.handle(IPC.spotifyQueueGet, (event) => {
    requireTrusted(event, IPC.spotifyQueueGet)
    return services.lyrics.getQueue()
  })
  ipcMain.handle(IPC.spotifyBridgeStatus, (event) => {
    requireTrusted(event, IPC.spotifyBridgeStatus)
    return getBridgeSetupStatus()
  })
  ipcMain.handle(IPC.spotifyInstallBridge, (event) => {
    requireTrusted(event, IPC.spotifyInstallBridge)
    log('info', 'Spicetify bridge install requested')
    return installBridge()
  })
  // ----- window ------------------------------------------------------------
  ipcMain.on(IPC.windowMinimize, (event) => {
    const win = targetWindow(event)
    if (win && senderWindow(event)) win.minimize()
  })
  ipcMain.on(IPC.windowToggleMaximize, (event) => {
    const win = targetWindow(event)
    if (win && senderWindow(event)) toggleMaximize(win)
  })
  ipcMain.on(IPC.windowClose, (event) => {
    const win = targetWindow(event)
    if (win && senderWindow(event)) win.close()
  })
  ipcMain.handle(IPC.windowSetFullscreen, (event, fullscreen: unknown) => {
    const win = requireTrusted(event, IPC.windowSetFullscreen)
    if (typeof fullscreen !== 'boolean') throw new TypeError('fullscreen must be a boolean')
    setFullscreen(win, fullscreen)
  })
  ipcMain.handle(IPC.windowToggleFullscreen, (event) => {
    const win = requireTrusted(event, IPC.windowToggleFullscreen)
    return toggleFullscreen(win)
  })
  ipcMain.handle(IPC.windowGetState, (event) => {
    const win = requireTrusted(event, IPC.windowGetState)
    return getWindowState(win)
  })
  ipcMain.handle(IPC.windowSetAlwaysOnTop, (event, value: unknown) => {
    const win = requireTrusted(event, IPC.windowSetAlwaysOnTop)
    if (typeof value !== 'boolean') throw new TypeError('alwaysOnTop must be a boolean')
    if (win.isAlwaysOnTop() !== value) win.setAlwaysOnTop(value, 'floating')
    settingsStore.set({ general: { alwaysOnTop: value } })
  })

  // ----- app ---------------------------------------------------------------
  ipcMain.handle(IPC.appGetInfo, (event) => {
    requireTrusted(event, IPC.appGetInfo)
    return buildAppInfo()
  })
  ipcMain.handle(IPC.appOpenExternal, async (event, raw: unknown) => {
    requireTrusted(event, IPC.appOpenExternal)
    const url = parseExternalUrl(raw)
    log('info', 'Opening external link', url)
    await shell.openExternal(url)
  })
  ipcMain.handle(IPC.appOpenLogs, async (event) => {
    requireTrusted(event, IPC.appOpenLogs)
    const logPath = getLogPath()
    if (existsSync(logPath)) {
      shell.showItemInFolder(logPath)
      return
    }
    const dir = getLogDir()
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* openPath reports the failure below */
    }
    const problem = await shell.openPath(dir)
    if (problem) throw new Error(problem)
  })
  ipcMain.handle(IPC.appOpenUserData, async (event) => {
    requireTrusted(event, IPC.appOpenUserData)
    const problem = await shell.openPath(getUserDataPath())
    if (problem) throw new Error(problem)
  })
  ipcMain.on(IPC.appRelaunch, (event) => {
    if (!senderWindow(event)) return
    log('info', 'Relaunch requested by the renderer')
    setQuitting(true)
    app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') })
    app.quit()
  })
  ipcMain.on(IPC.appQuit, (event) => {
    if (!senderWindow(event)) return
    log('info', 'Quit requested by the renderer')
    setQuitting(true)
    app.quit()
  })
  ipcMain.on(IPC.appLog, (event, payload: unknown) => {
    if (!senderWindow(event) || !isPlainObject(payload)) return
    const level = isLogLevel(payload.level) ? payload.level : 'info'
    const message = clampString(payload.message, MAX_LOG_MESSAGE)
    if (message === undefined) return
    log(level, `[renderer] ${message}`, clampString(payload.detail, MAX_LOG_DETAIL))
  })
  ipcMain.on(IPC.appRendererError, (event, report: unknown) => {
    if (!senderWindow(event) || !isPlainObject(report)) return
    const message = clampString(report.message, MAX_LOG_MESSAGE) ?? 'Unknown renderer error'
    const parts: string[] = []
    const stack = clampString(report.stack, MAX_LOG_DETAIL)
    const componentStack = clampString(report.componentStack, MAX_LOG_DETAIL)
    const source = clampString(report.source, 500)
    if (source) parts.push(`source: ${source}`)
    if (stack) parts.push(stack)
    if (componentStack) parts.push(`component stack:${componentStack}`)
    log('error', `[renderer] ${message}`, parts.length ? parts.join('\n') : undefined)
  })
  ipcMain.handle(IPC.appCheckUpdates, (event) => {
    requireTrusted(event, IPC.appCheckUpdates)
    return checkForUpdates()
  })
  ipcMain.handle(IPC.appGetUpdateStatus, (event) => {
    requireTrusted(event, IPC.appGetUpdateStatus)
    return getUpdateState()
  })
  ipcMain.handle(IPC.appDownloadUpdate, (event) => {
    requireTrusted(event, IPC.appDownloadUpdate)
    return downloadUpdate()
  })
  ipcMain.handle(IPC.appInstallUpdate, (event) => {
    requireTrusted(event, IPC.appInstallUpdate)
    return installUpdate()
  })
  ipcMain.handle(IPC.appClearArtworkCache, (event) => {
    requireTrusted(event, IPC.appClearArtworkCache)
    return metadata.clearCache()
  })

  log('debug', 'IPC handlers registered')
}
