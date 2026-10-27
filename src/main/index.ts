/**
 * VibeSync main process entry.
 *
 * Startup order (on `ready`): logger -> settings -> session policy -> window -> IPC ->
 * audio service -> metadata service -> tray -> login item sync -> updater.
 *
 * Environment / CLI:
 *   VIBEDECK_USER_DATA=<dir>  isolated profile (used by the e2e tests)
 *   VIBEDECK_DEVTOOLS=1       allow DevTools in a packaged build
 *   --hidden                  start hidden in the tray (Windows startup entry)
 */
import { app, BrowserWindow, Menu, session } from 'electron'
import { IPC } from '../shared/ipc'
import { AudioService } from './audioService'
import { applyGpuPreference, noteGpuCrash } from './gpuGuard'
import { installDisplayMediaHandler, installPermissionHandlers } from './displayMedia'
import { HelperSupervisor } from './helperSupervisor'
import { registerIpc } from './ipc'
import { flushLogSync, initLogger, log } from './logger'
import { applyLoginItem, syncLoginItem } from './loginItem'
import { MetadataService } from './metadataService'
import { LyricsService } from './lyricsService'
import { getHelperPath, helperExists, isPortable } from './paths'
import { settingsStore } from './settingsStore'
import { installScreenAwake } from './screenAwake'
import { createTray, destroyTray, hasTray, refreshTrayMenu } from './tray'
import { initUpdater } from './updater'
import { applyAlwaysOnTop, createMainWindow, getMainWindow, isQuitting, setQuitting, showMainWindow } from './window'
import { saveWindowStateNow } from './windowState'

const APP_USER_MODEL_ID = 'com.vibesync.app'
const SHUTDOWN_TIMEOUT_MS = 1_500

app.setName('VibeSync')

const startHiddenArg = process.argv.includes('--hidden')

// --- pre-ready configuration -------------------------------------------------

if (process.env.VIBEDECK_USER_DATA) {
  app.setPath('userData', process.env.VIBEDECK_USER_DATA)
  app.setPath('sessionData', process.env.VIBEDECK_USER_DATA)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  bootstrap()
}

function bootstrap(): void {
  app.setAppUserModelId(APP_USER_MODEL_ID)
  Menu.setApplicationMenu(null)
  // Must happen before the app is ready: turns the GPU off for this launch when the user
  // asked for software rendering (or a previous run fell back after repeated GPU crashes).
  applyGpuPreference(process.argv)

  let supervisor: HelperSupervisor | null = null
  let audioService: AudioService | null = null
  let lyricsService: LyricsService | null = null
  let shutdownStarted = false
  let shutdownDone = false
  let screenAwake: ReturnType<typeof installScreenAwake> | null = null

  const wantsTray = (): boolean => {
    const g = settingsStore.get().general
    return g.closeBehavior === 'tray' || g.startMinimized || startHiddenArg
  }

  const syncTray = (): void => {
    if (wantsTray()) {
      if (!hasTray()) createTray()
      else refreshTrayMenu()
    } else if (hasTray()) {
      destroyTray()
    }
  }

  process.on('uncaughtException', (err) => {
    log('error', 'Uncaught exception in the main process', err)
  })
  process.on('unhandledRejection', (reason) => {
    log('error', 'Unhandled promise rejection in the main process', reason)
  })

  app.on('second-instance', (_event, argv) => {
    log('info', 'Second instance launched; focusing the existing window', argv.join(' '))
    showMainWindow()
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })

  app.on('child-process-gone', (_event, details) => {
    const level = details.reason === 'clean-exit' ? 'info' : 'warn'
    log(level, `Child process gone: ${details.type} ${details.name ?? ''} (${details.reason}, exit code ${details.exitCode})`.replace(/\s+/g, ' '))
    if (details.type === 'GPU' && details.reason !== 'clean-exit') {
      // Too many of these and Chromium kills the whole app: fall back to software rendering.
      if (noteGpuCrash(details.reason, details.exitCode)) return
      // Accelerated 2D canvases lose their backing store when the GPU process dies; tell the
      // renderer to re-create them once the new GPU process is up.
      setTimeout(() => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(IPC.appGpuReset)
        }
      }, 600)
    }
  })

  app.on('window-all-closed', () => {
    if (!isQuitting() && settingsStore.get().general.closeBehavior === 'tray' && hasTray()) {
      log('info', 'All windows closed; staying in the tray')
      return
    }
    app.quit()
  })

  const shutdown = async (): Promise<void> => {
    if (shutdownDone) return
    log('info', 'Shutting down')
    screenAwake?.dispose()
    destroyTray()
    const win = getMainWindow()
    if (win) saveWindowStateNow(win)
    settingsStore.flushSync()
    if (audioService) {
      await Promise.race([
        audioService.stop().catch((err: unknown) => log('warn', 'Audio service stop failed', err)),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS))
      ])
    }
    lyricsService?.stop()
    supervisor?.dispose()
    shutdownDone = true
  }

  app.on('before-quit', (event) => {
    setQuitting(true)
    if (shutdownDone) return
    if (shutdownStarted) {
      // Still waiting for the helper - keep the app alive until shutdown() calls quit again.
      event.preventDefault()
      return
    }
    shutdownStarted = true
    event.preventDefault()
    shutdown()
      .catch((err: unknown) => log('error', 'Shutdown failed', err))
      .finally(() => {
        shutdownDone = true
        app.quit()
      })
  })

  app.on('quit', (_event, exitCode) => {
    log('info', `VibeSync exited (code ${exitCode})`)
    flushLogSync()
  })

  process.on('exit', () => {
    supervisor?.dispose()
    flushLogSync()
  })

  app.whenReady().then(
    () => {
      try {
        onReady()
      } catch (err) {
        log('error', 'Fatal error during startup', err)
        flushLogSync()
        app.exit(1)
      }
    },
    (err: unknown) => {
      log('error', 'Electron failed to become ready', err)
      flushLogSync()
      app.exit(1)
    }
  )

  function onReady(): void {
    initLogger()
    log(
      'info',
      `VibeSync ${app.getVersion()} starting (Electron ${process.versions.electron}, Chrome ${process.versions.chrome}, ` +
        `${process.platform} ${process.arch}, ${app.isPackaged ? 'packaged' : 'development'}${isPortable ? ', portable' : ''}` +
        `${startHiddenArg ? ', --hidden' : ''})`
    )
    log('info', 'User data', app.getPath('userData'))

    const settings = settingsStore.load()
    const startHidden = startHiddenArg || settings.general.startMinimized

    installPermissionHandlers(session.defaultSession)
    installDisplayMediaHandler(session.defaultSession)

    // Tray first so the window knows whether it may stay hidden / hide on close.
    if (wantsTray()) createTray()
    const awakeWindow = createMainWindow({ startHidden })
    screenAwake = installScreenAwake(awakeWindow, () => !isQuitting() && settingsStore.get().general.keepScreenAwake)

    const sv = new HelperSupervisor()
    supervisor = sv
    const audio = new AudioService(sv)
    audioService = audio
    const metadata = new MetadataService(sv)

    const lyrics = new LyricsService(metadata)
    lyricsService = lyrics
    registerIpc({ audio, metadata, lyrics })
    lyrics.start()
    log('info', `Helper ${helperExists() ? 'found' : 'missing'}`, getHelperPath())
    audio.start()
    metadata.start()

    // Chromium loopback capture lives in the renderer, so every (re)load must re-arm it.
    const mainWin = getMainWindow()
    if (mainWin) mainWin.webContents.on('did-finish-load', () => audio.handleRendererReady())

    settingsStore.subscribe((next, prev) => {
      if (next.general.keepScreenAwake !== prev.general.keepScreenAwake) screenAwake?.refresh()
      if (next.general.alwaysOnTop !== prev.general.alwaysOnTop) applyAlwaysOnTop(next.general.alwaysOnTop)
      if (next.general.startWithWindows !== prev.general.startWithWindows) applyLoginItem(next.general.startWithWindows)
      if (
        next.general.closeBehavior !== prev.general.closeBehavior ||
        next.general.startMinimized !== prev.general.startMinimized ||
        next.general.lastMode !== prev.general.lastMode
      ) {
        syncTray()
      }
      if (next.audio.engine !== prev.audio.engine || next.audio.deviceId !== prev.audio.deviceId) audio.applySettings()
    })

    syncLoginItem(settings.general.startWithWindows)
    initUpdater({ autoCheck: settings.general.checkForUpdates })
    log('info', `Startup complete (${BrowserWindow.getAllWindows().length} window(s), tray ${hasTray() ? 'on' : 'off'})`)
  }
}
