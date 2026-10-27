/**
 * Shared launch helpers for the VibeDeck Playwright suite.
 *
 * Every test starts the built app (out/main/index.js) with an isolated user-data directory so
 * settings, window state, logs and the artwork cache never leak between tests or into a real
 * profile. `VIBEDECK_USER_DATA` is honoured by src/main/index.ts before Electron is ready, and
 * Electron's single-instance lock is scoped to that directory, so a test instance never
 * collides with a VibeDeck the developer has open.
 *
 * The e2e suite deliberately avoids DOM types (tests/e2e is type-checked with
 * tsconfig.node.json, which has no DOM lib) - everything goes through Playwright locators.
 */
import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@playwright/test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Settings, VisualMode } from '../../src/shared/settings'
import type { CaptureState } from '../../src/shared/types'

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
export const MAIN_ENTRY = path.join(PROJECT_ROOT, 'out', 'main', 'index.js')

export const VISUAL_MODES: readonly VisualMode[] = ['visualizer']
export const SETTINGS_TABS = ['general', 'audio', 'visualizer', 'colors', 'spotify', 'shortcuts', 'about'] as const
export type SettingsTabId = (typeof SETTINGS_TABS)[number]
export const CAPTURE_STATES: readonly CaptureState[] = ['idle', 'starting', 'connected', 'reconnecting', 'error']
/** Visible badge text per state - mirrors STATUS_TEXT in src/renderer/src/components/AudioStatusBadge.tsx. */
export const STATUS_TEXT: Record<CaptureState, string> = {
  idle: 'Not connected',
  starting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  error: 'Not connected'
}

const LAUNCH_TIMEOUT_MS = 30_000
const EXIT_TIMEOUT_MS = 15_000
const KILL_TIMEOUT_MS = 5_000

export interface VibeDeckApp {
  app: ElectronApplication
  page: Page
  userDataDir: string
  /** Uncaught exceptions raised in the renderer (page 'pageerror' events). */
  pageErrors: Error[]
  /** console.error output from the renderer (diagnostics only, never asserted). */
  consoleErrors: string[]
  /** Quit the app and wait for the Electron process to exit. Safe to call twice. */
  close(): Promise<void>
}

export function assertBuildExists(): void {
  if (existsSync(MAIN_ENTRY)) return
  throw new Error(
    `VibeDeck is not built: ${MAIN_ENTRY} does not exist.\n` +
      'Run `npm run helper:build` and `npm run build` from the project root before `npm run test:e2e`.'
  )
}

/** Resolves true when the Electron process has exited, false when `timeoutMs` elapsed first. */
export function waitForExit(app: ElectronApplication, timeoutMs = EXIT_TIMEOUT_MS): Promise<boolean> {
  const proc = app.process()
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      proc.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    proc.once('exit', onExit)
  })
}

/**
 * Quit through Electron (`app.quit()` -> before-quit -> settings flush -> helper shutdown) and
 * wait for the process to be gone. Falls back to killing the process if the graceful path
 * hangs, so a stuck helper never blocks the next test's single-instance lock.
 */
export async function closeApp(app: ElectronApplication): Promise<void> {
  const proc = app.process()
  const exited = waitForExit(app)
  try {
    await app.close()
  } catch {
    // The app may already be gone (crashed or quit on its own); the exit wait below covers it.
  }
  if (await exited) return
  proc.kill()
  if (!(await waitForExit(app, KILL_TIMEOUT_MS))) {
    throw new Error(`VibeDeck process (pid ${proc.pid ?? '?'}) did not exit after being killed`)
  }
}

export interface LaunchOptions {
  /** Extra environment for the Electron process. */
  env?: Record<string, string>
}

/**
 * Launch VibeDeck with the given user-data directory and wait until the React shell
 * (`[data-testid=app-root]`) is on screen.
 */
export async function launchVibeDeck(userDataDir: string, options: LaunchOptions = {}): Promise<VibeDeckApp> {
  assertBuildExists()
  mkdirSync(userDataDir, { recursive: true })

  // Playwright wants string-only values; process.env may contain undefined entries.
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  Object.assign(env, options.env, { VIBEDECK_USER_DATA: userDataDir, NODE_ENV: 'production' })
  // Inherited from an Electron-hosted terminal (VS Code) this would start Electron as plain Node.
  delete env.ELECTRON_RUN_AS_NODE

  const app = await electron.launch({
    executablePath: process.env.VIBESYNC_TEST_EXECUTABLE,
    args: [...(process.env.VIBESYNC_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), MAIN_ENTRY],
    cwd: PROJECT_ROOT,
    env,
    timeout: LAUNCH_TIMEOUT_MS
  })

  const pageErrors: Error[] = []
  const consoleErrors: string[] = []
  const attached = new WeakSet<Page>()
  const attach = (p: Page): void => {
    if (attached.has(p)) return
    attached.add(p)
    p.on('pageerror', (err) => pageErrors.push(err))
    p.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
  }
  app.on('window', attach)
  for (const w of app.windows()) attach(w)

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await closeApp(app)
  }

  try {
    const page = await app.firstWindow()
    attach(page)

    const root = page.getByTestId('app-root')
    const fallback = page.getByTestId('boot-fallback')
    await expect(root.or(fallback)).toBeVisible({ timeout: LAUNCH_TIMEOUT_MS })
    if ((await fallback.count()) > 0) {
      throw new Error(
        'VibeDeck rendered the boot fallback: window.vibedeck (the preload bridge) is missing. ' +
          'Check out/preload/index.js and the BrowserWindow preload path.'
      )
    }
    if ((await root.getAttribute('data-fatal')) === 'true') {
      throw new Error(`VibeDeck reported a fatal start-up error: ${(await root.innerText()).trim()}`)
    }
    return { app, page, userDataDir, pageErrors, consoleErrors, close }
  } catch (err) {
    await close().catch(() => undefined)
    throw err
  }
}

/** Per-test user-data directory inside Playwright's output folder (cleaned by the runner). */
export function userDataDirFor(testInfo: TestInfo, name = 'user-data'): string {
  return testInfo.outputPath(name)
}

/**
 * Dismiss the first-run dialog when it is showing. Returns true when it was shown.
 * The dialog state is decided before React mounts (settings are loaded first), so a
 * synchronous count() is reliable once app-root is visible.
 */
export async function completeFirstRun(page: Page): Promise<boolean> {
  const dialog = page.getByTestId('first-run-dialog')
  if ((await dialog.count()) === 0) return false
  await page.getByTestId('first-run-continue').press('Enter')
  await expect(dialog).toHaveCount(0)
  return true
}

/** Open the settings panel (if needed) and select a tab. */
export async function openSettingsTab(page: Page, tab: SettingsTabId): Promise<void> {
  const panel = page.getByTestId('settings-panel')
  if ((await panel.count()) === 0) {
    await page.getByTestId('settings-button').press('Enter')
    await expect(panel).toBeVisible()
  }
  await page.getByTestId(`settings-tab-${tab}`).press('Enter')
  await expect(panel).toHaveAttribute('data-tab', tab)
}

/** Fullscreen state of the main BrowserWindow, read in the Electron main process. */
export function isFullScreen(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return win ? win.isFullScreen() : false
  })
}

/** Parse <userData>/settings.json; null while the file does not exist yet (or is mid-write). */
export function readSettingsFile(userDataDir: string): Settings | null {
  const file = path.join(userDataDir, 'settings.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Settings
  } catch {
    return null
  }
}

/** Attach renderer diagnostics and (on failure) a screenshot + the main-process log. */
export async function attachDiagnostics(instance: VibeDeckApp, testInfo: TestInfo): Promise<void> {
  const failed = testInfo.status !== undefined && testInfo.status !== testInfo.expectedStatus
  if (failed && !instance.page.isClosed()) {
    try {
      const shot = await instance.page.screenshot({ type: 'png' })
      await testInfo.attach('failure-screenshot.png', { body: shot, contentType: 'image/png' })
    } catch {
      // the window may already be gone
    }
  }
  if (instance.pageErrors.length > 0) {
    const body = instance.pageErrors.map((e) => e.stack || e.message).join('\n\n')
    await testInfo.attach('renderer-page-errors.txt', { body, contentType: 'text/plain' })
  }
  if (instance.consoleErrors.length > 0) {
    await testInfo.attach('renderer-console-errors.txt', {
      body: instance.consoleErrors.join('\n'),
      contentType: 'text/plain'
    })
  }
  await instance.close()
  const logFile = path.join(instance.userDataDir, 'logs', 'vibedeck.log')
  if (failed && existsSync(logFile)) {
    await testInfo.attach('vibedeck.log', { path: logFile, contentType: 'text/plain' })
  }
}

export interface VibeDeckFixtures {
  /** A freshly launched VibeDeck with an empty profile; closed automatically after the test. */
  vibedeck: VibeDeckApp
}

export const test = base.extend<VibeDeckFixtures>({
  vibedeck: async ({}, use, testInfo) => {
    const instance = await launchVibeDeck(userDataDirFor(testInfo))
    try {
      await use(instance)
    } finally {
      await attachDiagnostics(instance, testInfo)
    }
  }
})

export { expect }
