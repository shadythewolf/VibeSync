/**
 * Updates from GitHub Releases (electron-updater).
 *
 * The feed comes from the `publish` entry in electron-builder.yml (written into the
 * packaged app as resources/app-update.yml); VIBEDECK_UPDATE_URL can point a build at a
 * generic feed instead. Nothing is downloaded or installed without the user clicking.
 *
 * Self-install works for the Windows installer (NSIS), the AppImage and the .deb.
 * The portable .exe and unpackaged runs can only check; they link to the release page.
 */
import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import type { UpdateCheckResult } from '../shared/types'
import { errorMessage, log } from './logger'
import { isPortable } from './paths'
import { setQuitting } from './window'

export const RELEASES_URL = 'https://github.com/shadythewolf/VibeSync/releases/latest'
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

type AppUpdater = import('electron-updater').AppUpdater

let updater: AppUpdater | null = null
let state: UpdateCheckResult = { status: 'idle', releaseUrl: RELEASES_URL }
let inflight: Promise<UpdateCheckResult> | null = null
let downloading: Promise<void> | null = null

/** HTTPS feed override; plain HTTP only on this machine, for testing an update locally. */
function genericFeedUrl(): string | null {
  const fromEnv = process.env.VIBEDECK_UPDATE_URL
  return fromEnv && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/i.test(fromEnv) ? fromEnv : null
}

/** A packaged build carries app-update.yml; unpackaged runs have nothing to compare against. */
export function updatesConfigured(): boolean {
  return app.isPackaged && (genericFeedUrl() !== null || existsSync(join(process.resourcesPath, 'app-update.yml')))
}

/**
 * install-linux.sh passes the AppImage path as VIBESYNC_APPIMAGE because extract-and-run mode
 * strips APPIMAGE*. Restore what electron-updater reads; the restarted new version inherits it.
 */
function restoreAppImageEnv(): void {
  const path = process.env.VIBESYNC_APPIMAGE
  if (!process.env.APPIMAGE && path && path.startsWith('/')) process.env.APPIMAGE = path
  if (process.env.VIBESYNC_EXTRACT_AND_RUN === '1') process.env.APPIMAGE_EXTRACT_AND_RUN = '1'
}

/** Whether this kind of install can replace itself. */
export function canSelfInstall(): boolean {
  if (process.platform === 'linux') restoreAppImageEnv()
  if (!app.isPackaged || isPortable) return false
  if (process.platform === 'win32') return true
  // AppImage runtime sets APPIMAGE; electron-builder's .deb carries a package-type marker.
  if (process.platform === 'linux') return !!process.env.APPIMAGE || existsSync(join(process.resourcesPath, 'package-type'))
  return false
}

function publish(next: Partial<UpdateCheckResult>): UpdateCheckResult {
  state = { ...state, ...next, releaseUrl: RELEASES_URL, canInstall: canSelfInstall() }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.appUpdateStatus, state)
  }
  return state
}

export function getUpdateState(): UpdateCheckResult {
  return { ...state, releaseUrl: RELEASES_URL, canInstall: canSelfInstall() }
}

async function getUpdater(): Promise<AppUpdater> {
  if (updater) return updater
  // electron-updater is CommonJS with a lazy getter; the bundled dynamic import only exposes it on `default`.
  const mod = await import('electron-updater')
  const autoUpdater = ('autoUpdater' in mod && mod.autoUpdater) || (mod as unknown as { default: typeof mod }).default.autoUpdater
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = {
    info: (m: unknown) => log('info', `[updater] ${String(m)}`),
    warn: (m: unknown) => log('warn', `[updater] ${String(m)}`),
    error: (m: unknown) => log('error', `[updater] ${String(m)}`),
    debug: (m: string) => log('debug', `[updater] ${m}`)
  }
  const generic = genericFeedUrl()
  if (generic) autoUpdater.setFeedURL({ provider: 'generic', url: generic })
  autoUpdater.on('download-progress', (p) => publish({ status: 'downloading', percent: Math.round(p.percent) }))
  updater = autoUpdater
  return autoUpdater
}

export function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!updatesConfigured()) {
    return Promise.resolve(publish({
      status: 'not-configured',
      message: app.isPackaged ? 'This build has no update feed.' : 'Update checks only work in the installed app.'
    }))
  }
  // A finished or running download is more useful than a fresh check.
  if (state.status === 'downloading' || state.status === 'downloaded') return Promise.resolve(getUpdateState())
  inflight ??= runCheck().finally(() => { inflight = null })
  return inflight
}

async function runCheck(): Promise<UpdateCheckResult> {
  publish({ status: 'checking', message: undefined, percent: undefined })
  try {
    const result = await (await getUpdater()).checkForUpdates()
    const remote = result?.updateInfo.version
    if (result?.isUpdateAvailable && remote) {
      log('info', `Update available: ${remote}`)
      return publish({ status: 'available', version: remote, message: `VibeSync ${remote} is available.` })
    }
    return publish({ status: 'up-to-date', version: app.getVersion(), message: 'You are running the latest version.' })
  } catch (err) {
    log('warn', 'Update check failed', err)
    return publish({ status: 'error', message: `Update check failed: ${errorMessage(err)}` })
  }
}

/** Downloads the available update; installers that cannot self-install open the release page. */
export async function downloadUpdate(): Promise<void> {
  if (!canSelfInstall()) {
    await shell.openExternal(RELEASES_URL)
    return
  }
  if (state.status !== 'available') return
  downloading ??= (async () => {
    try {
      publish({ status: 'downloading', percent: 0 })
      await (await getUpdater()).downloadUpdate()
      log('info', `Update ${state.version ?? ''} downloaded`)
      publish({ status: 'downloaded', percent: 100, message: `VibeSync ${state.version ?? ''} is ready to install.` })
    } catch (err) {
      log('warn', 'Update download failed', err)
      publish({ status: 'available', percent: undefined, message: `Download failed: ${errorMessage(err)}` })
    } finally {
      downloading = null
    }
  })()
  return downloading
}

/** Quits and runs the downloaded installer, then starts the new version. */
export async function installUpdate(): Promise<void> {
  if (state.status !== 'downloaded' || !updater) return
  log('info', `Installing update ${state.version ?? ''}`)
  // The tray close behaviour would otherwise keep the app alive and block the installer.
  setQuitting(true)
  updater.quitAndInstall(true, true)
}

/** Background checks at launch and every few hours, if the user allows it. */
export function initUpdater(options: { autoCheck: boolean }): void {
  if (!updatesConfigured()) {
    log('debug', 'Updater: no feed in this build, skipping')
    return
  }
  if (!options.autoCheck) {
    log('debug', 'Updater: launch check disabled by settings')
    return
  }
  const check = (): void => { checkForUpdates().catch((err: unknown) => log('warn', 'Background update check failed', err)) }
  // Give the window a moment to come up before hitting the network.
  setTimeout(check, 8000).unref?.()
  setInterval(check, RECHECK_INTERVAL_MS).unref?.()
}
