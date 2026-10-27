/**
 * Windows "Run at startup" registration.
 *
 * Only ever touches the registry in a packaged build - registering electron.exe from a
 * dev checkout would be wrong. The portable build registers the real portable exe
 * (PORTABLE_EXECUTABLE_FILE) instead of the temporary extracted one.
 */
import { app } from 'electron'
import { log } from './logger'

const LOGIN_ITEM_NAME = 'VibeSync'
const LOGIN_ARGS = ['--hidden']

function loginItemPath(): string {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
}

export function isLoginItemRegistered(): boolean {
  if (!app.isPackaged) return false
  try {
    return app.getLoginItemSettings({ path: loginItemPath(), args: LOGIN_ARGS }).openAtLogin
  } catch (err) {
    log('warn', 'getLoginItemSettings failed', err)
    return false
  }
}

export function applyLoginItem(enabled: boolean): void {
  if (!app.isPackaged) {
    log('debug', `Login item not touched in development (requested ${enabled ? 'on' : 'off'})`)
    return
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: loginItemPath(),
      args: LOGIN_ARGS,
      name: LOGIN_ITEM_NAME
    })
    const actual = isLoginItemRegistered()
    if (actual !== enabled) {
      log('warn', `Login item state mismatch after apply: wanted ${enabled}, registry says ${actual}`)
    } else {
      log('info', `Start with Windows ${enabled ? 'enabled' : 'disabled'}`)
    }
  } catch (err) {
    log('error', 'setLoginItemSettings failed', err)
  }
}

/**
 * Bring the registry in line with the saved setting on startup: re-register when the
 * entry is missing (e.g. the install path changed), remove it when the setting is off.
 * The Task Manager "disabled" flag (executableWillLaunchAtLogin) is left to the user.
 */
export function syncLoginItem(desired: boolean): void {
  if (!app.isPackaged) return
  const registered = isLoginItemRegistered()
  if (registered !== desired) applyLoginItem(desired)
}
