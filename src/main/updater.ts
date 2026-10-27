/**
 * Update checks (electron-updater, generic provider).
 *
 * No feed is configured for this build: `UPDATE_FEED_URL` is empty, so every check
 * reports 'not-configured'. Drop a URL into the constant (or set the environment variable
 * VIBEDECK_UPDATE_URL when packaging) and the code below becomes live without changes.
 */
import { app } from 'electron'
import type { UpdateCheckResult } from '../shared/types'
import { errorMessage, log } from './logger'

/** Generic electron-updater feed URL. Empty string = updates not configured. */
export const UPDATE_FEED_URL: string = ''

let inflight: Promise<UpdateCheckResult> | null = null
let lastResult: UpdateCheckResult | null = null

export function getUpdateFeedUrl(): string {
  const fromEnv = process.env.VIBEDECK_UPDATE_URL
  if (fromEnv && /^https:\/\//i.test(fromEnv)) return fromEnv
  return UPDATE_FEED_URL
}

export function updatesConfigured(): boolean {
  return getUpdateFeedUrl().length > 0
}

const NOT_CONFIGURED: UpdateCheckResult = {
  status: 'not-configured',
  message: 'Automatic updates are not configured for this build. Get new versions from the maintainer of this VibeSync fork.'
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const url = getUpdateFeedUrl()
  if (!url) return NOT_CONFIGURED
  if (inflight) return inflight
  if (!app.isPackaged) {
    return { status: 'error', message: 'Update checks only work in the installed application.' }
  }
  inflight = runCheck(url).finally(() => {
    inflight = null
  })
  return inflight
}

async function runCheck(url: string): Promise<UpdateCheckResult> {
  try {
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = {
      info: (m: unknown) => log('info', `[updater] ${String(m)}`),
      warn: (m: unknown) => log('warn', `[updater] ${String(m)}`),
      error: (m: unknown) => log('error', `[updater] ${String(m)}`),
      debug: (m: string) => log('debug', `[updater] ${m}`)
    }
    autoUpdater.setFeedURL({ provider: 'generic', url })
    log('info', 'Checking for updates', url)
    const result = await autoUpdater.checkForUpdates()
    if (!result) {
      lastResult = { status: 'up-to-date', version: app.getVersion(), message: 'You are running the latest version.' }
      return lastResult
    }
    const remote = result.updateInfo.version
    if (result.isUpdateAvailable) {
      lastResult = { status: 'available', version: remote, message: `VibeSync ${remote} is available.` }
    } else {
      lastResult = { status: 'up-to-date', version: app.getVersion(), message: 'You are running the latest version.' }
    }
    log('info', `Update check: ${lastResult.status}`, remote)
    return lastResult
  } catch (err) {
    const message = errorMessage(err)
    log('warn', 'Update check failed', err)
    lastResult = { status: 'error', message: `Update check failed: ${message}` }
    return lastResult
  }
}

export function getLastUpdateResult(): UpdateCheckResult | null {
  return lastResult
}

/**
 * Called once after startup. Performs a background check only when the user opted in
 * and a feed is configured; otherwise it is a no-op.
 */
export function initUpdater(options: { autoCheck: boolean }): void {
  if (!updatesConfigured()) {
    log('debug', 'Updater: no feed configured, skipping')
    return
  }
  if (!options.autoCheck) {
    log('debug', 'Updater: launch check disabled by settings')
    return
  }
  // Give the window a moment to come up before hitting the network.
  const timer = setTimeout(() => {
    checkForUpdates().catch((err: unknown) => log('warn', 'Launch update check failed', err))
  }, 8000)
  timer.unref?.()
}
