/**
 * Filesystem locations used by the main process.
 */
import { app } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const HELPER_EXE = 'VibeDeckHelper.exe'
export const LINUX_HELPER = 'vibedeck-linux-helper.cjs'

/** True when running from electron-builder's portable target. */
export const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR

/**
 * Location of the native helper.
 *  dev:      <project>/helper/bin/VibeDeckHelper.exe (output of `npm run helper:build`)
 *  packaged: <install>/resources/helper/VibeDeckHelper.exe (electron-builder extraResources)
 */
export function getHelperPath(): string {
  if (process.platform === 'linux') {
    if (app.isPackaged) return join(process.resourcesPath, 'linux-helper', LINUX_HELPER)
    const candidates = [
      join(__dirname, '..', '..', 'linux-helper', LINUX_HELPER),
      join(app.getAppPath(), 'linux-helper', LINUX_HELPER),
      join(process.cwd(), 'linux-helper', LINUX_HELPER)
    ]
    for (const c of candidates) {
      try {
        if (existsSync(c) && statSync(c).isFile()) return c
      } catch {
        /* try the next candidate */
      }
    }
    return candidates[0]
  }
  if (app.isPackaged) return join(process.resourcesPath, 'helper', HELPER_EXE)
  // Development / unpackaged: the entry file is always out/main/index.js, but app.getAppPath()
  // differs between `electron .` (project root) and `electron out/main/index.js` (out/main).
  // Try every plausible root and take the first that actually has the helper.
  const candidates = [
    join(__dirname, '..', '..', 'helper', 'bin', HELPER_EXE),
    join(app.getAppPath(), 'helper', 'bin', HELPER_EXE),
    join(process.cwd(), 'helper', 'bin', HELPER_EXE)
  ]
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c
    } catch {
      /* try the next candidate */
    }
  }
  return candidates[0]
}

export function getHelperLaunch(): { command: string; args: string[]; env?: NodeJS.ProcessEnv } {
  const helper = getHelperPath()
  if (process.platform !== 'linux') return { command: helper, args: [] }
  return { command: process.execPath, args: [helper], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
}

export function helperExists(): boolean {
  try {
    const p = getHelperPath()
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

export function getUserDataPath(): string {
  return app.getPath('userData')
}

export function getSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getWindowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

export function getArtworkDir(): string {
  return join(app.getPath('userData'), 'artwork')
}

