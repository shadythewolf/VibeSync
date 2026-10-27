/**
 * VibeSync end-to-end tests (Playwright + Electron).
 *
 * Prerequisites:  npm run helper:build && npm run build      (produces out/ and helper/bin)
 * Run:            npm run test:e2e
 *                 npx playwright test -c tests/e2e/playwright.config.ts -g "fullscreen"
 *
 * The data-testid attributes used here are the shared contract with the renderer
 * (see docs/TESTING.md).
 */
import {
  CAPTURE_STATES,
  SETTINGS_TABS,
  STATUS_TEXT,
  VISUAL_MODES,
  completeFirstRun,
  expect,
  isFullScreen,
  launchVibeDeck,
  openSettingsTab,
  readSettingsFile,
  test,
  userDataDirFor
} from './fixtures'
import type { CaptureState } from '../../src/shared/types'

const MODE_PATTERN = /^visualizer$/

test.describe('VibeSync desktop app', () => {
  test('launches, shows the app root and completes the first-run dialog', async ({ vibedeck }) => {
    const { page, userDataDir } = vibedeck

    await expect(page).toHaveTitle(/VibeSync/)
    const root = page.getByTestId('app-root')
    await expect(root).toBeVisible()
    await expect(root).toHaveAttribute('data-mode', MODE_PATTERN)

    // A fresh profile must show the welcome dialog exactly once.
    const shown = await completeFirstRun(page)
    expect(shown, 'first-run dialog should appear for a fresh profile').toBe(true)
    await expect(page.getByTestId('first-run-dialog')).toHaveCount(0)
    await expect.poll(() => readSettingsFile(userDataDir)?.general.firstRunCompleted, {
      message: 'firstRunCompleted should be persisted to settings.json'
    }).toBe(true)

    // The shell chrome is present.
    await expect(page.getByTestId('mode-visualizer')).toBeVisible()
    await expect(page.getByTestId('audio-status')).toBeVisible()
    await expect(page.getByTestId('always-on-top-toggle')).toBeVisible()
    await expect(page.getByTestId('fullscreen-button')).toBeVisible()
    await expect(page.getByTestId('settings-button')).toBeVisible()
  })

  test('only the visualizer remains, including after former DJ shortcuts', async ({ vibedeck }) => {
    const { page } = vibedeck
    await completeFirstRun(page)
    await expect(page.getByTestId('mode-btn-neon')).toHaveCount(0)
    await expect(page.getByTestId('mode-btn-pro')).toHaveCount(0)
    for (const key of ['F1', 'F2', 'F3']) {
      await page.keyboard.press(key)
      await expect(page.getByTestId('app-root')).toHaveAttribute('data-mode', 'visualizer')
    }
  })

  test('F11 enters fullscreen and Escape leaves it', async ({ vibedeck }) => {
    const { page, app } = vibedeck
    await completeFirstRun(page)
    const root = page.getByTestId('app-root')

    expect(await isFullScreen(app)).toBe(false)
    await expect(root).toHaveAttribute('data-fullscreen', 'false')

    await page.keyboard.press('F11')
    await expect.poll(() => isFullScreen(app), { message: 'window should be fullscreen after F11' }).toBe(true)
    await expect(root).toHaveAttribute('data-fullscreen', 'true')

    await page.keyboard.press('Escape')
    await expect.poll(() => isFullScreen(app), { message: 'window should leave fullscreen on Escape' }).toBe(false)
    await expect(root).toHaveAttribute('data-fullscreen', 'false')

    // The title-bar button is the mouse equivalent of F11.
    await page.getByTestId('fullscreen-button').click()
    await expect.poll(() => isFullScreen(app)).toBe(true)
    await page.keyboard.press('F11')
    await expect.poll(() => isFullScreen(app)).toBe(false)
  })

  test('settings panel opens, switches tabs and closes', async ({ vibedeck }) => {
    const { page } = vibedeck
    await completeFirstRun(page)
    const panel = page.getByTestId('settings-panel')
    await expect(panel).toHaveCount(0)

    // Open with the title-bar button and walk every tab.
    await page.getByTestId('settings-button').click()
    await expect(panel).toBeVisible()
    await expect(page.getByTestId('settings-button')).toHaveAttribute('aria-expanded', 'true')
    for (const tab of [...SETTINGS_TABS.slice(1), SETTINGS_TABS[0]]) {
      await page.getByTestId(`settings-tab-${tab}`).click()
      await expect(panel).toHaveAttribute('data-tab', tab)
      await expect(page.getByTestId(`settings-tab-${tab}`)).toHaveAttribute('aria-selected', 'true')
    }

    // Escape closes.
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)

    // The close button closes.
    await page.getByTestId('settings-button').click()
    await expect(panel).toBeVisible()
    await page.getByTestId('settings-close').click()
    await expect(panel).toHaveCount(0)

    // Ctrl+, toggles.
    await page.keyboard.press('Control+,')
    await expect(panel).toBeVisible()
    await page.keyboard.press('Control+,')
    await expect(panel).toHaveCount(0)
  })

  test('bar count, FPS counter and last mode persist across a restart', async ({}, testInfo) => {
    test.slow() // two full launches
    const userDataDir = userDataDirFor(testInfo)

    // ---- session 1: change settings -------------------------------------------------------
    const first = await launchVibeDeck(userDataDir)
    let target = 0
    try {
      const { page } = first
      await completeFirstRun(page)

      await expect(page.getByTestId('app-root')).toHaveAttribute('data-mode', 'visualizer')

      await openSettingsTab(page, 'visualizer')
      const slider = page.getByTestId('setting-barCount')
      await expect(slider).toBeVisible()
      const initial = Number(await slider.inputValue())
      const max = Number(await slider.getAttribute('max'))
      expect(Number.isFinite(max) && max > initial, 'slider max should exceed the default').toBe(true)

      // Real keyboard interaction on the range input: End = max, then four steps down.
      target = max - 4
      await slider.press('End')
      for (let i = 0; i < 4; i++) await slider.press('ArrowLeft')
      await expect(slider).toHaveValue(String(target))

      const fps = page.getByTestId('setting-showFps')
      await expect(fps).not.toBeChecked()
      await fps.check()
      await expect(fps).toBeChecked()

      // The renderer debounces (80 ms) and the main process saves atomically (150 ms).
      await expect.poll(() => readSettingsFile(userDataDir)?.visualizer.barCount, {
        message: 'barCount should reach settings.json'
      }).toBe(target)
      await expect.poll(() => readSettingsFile(userDataDir)?.visualizer.showFps).toBe(true)
      await expect.poll(() => readSettingsFile(userDataDir)?.general.lastMode).toBe('visualizer')
    } finally {
      await first.close()
    }

    // ---- session 2: same profile, everything restored ---------------------------------------
    const second = await launchVibeDeck(userDataDir)
    try {
      const { page } = second
      await expect(page.getByTestId('first-run-dialog')).toHaveCount(0)
      await expect(page.getByTestId('app-root')).toHaveAttribute('data-mode', 'visualizer')

      await openSettingsTab(page, 'visualizer')
      await expect(page.getByTestId('setting-barCount')).toHaveValue(String(target))
      await expect(page.getByTestId('setting-showFps')).toBeChecked()

      const onDisk = readSettingsFile(userDataDir)
      expect(onDisk?.visualizer.barCount).toBe(target)
      expect(onDisk?.general.lastMode).toBe('visualizer')
    } finally {
      await second.close()
    }
  })

  test('audio status badge reports a valid capture state', async ({ vibedeck }, testInfo) => {
    const { page } = vibedeck
    await completeFirstRun(page)
    const badge = page.getByTestId('audio-status')
    await expect(badge).toBeVisible()

    // Give capture a moment to settle out of 'starting'; a slow machine may legitimately still
    // be connecting, which is a valid (soft) outcome.
    await expect
      .poll(() => badge.getAttribute('data-state'), { timeout: 15_000 })
      .not.toBe('starting')
      .catch(() => undefined)

    const state = await badge.getAttribute('data-state')
    const engine = (await badge.getAttribute('data-engine')) || 'none'
    const text = ((await badge.textContent()) ?? '').replace(/\s+/g, ' ').trim()
    const summary = `audio-status: state=${state} engine=${engine} text="${text}"`
    console.log(summary)
    testInfo.annotations.push({ type: 'audio-status', description: summary })

    expect(state, 'data-state must be one of the CaptureState values').not.toBeNull()
    expect(CAPTURE_STATES).toContain(state as CaptureState)
    expect(text.length, 'the badge must show a status text').toBeGreaterThan(0)
    if (state === 'connected') {
      expect(text).toBe(STATUS_TEXT.connected)
      await expect(page.getByTestId('audio-error-banner')).toHaveCount(0)
    }
    if (state === 'error') {
      // Not a failure (no playback device on CI, for example) - record why for the report.
      const banner = page.getByTestId('audio-error-banner')
      if ((await banner.count()) > 0) {
        const detail = ((await banner.innerText()) ?? '').replace(/\s+/g, ' ').trim()
        console.log(`audio-error-banner: ${detail}`)
        testInfo.annotations.push({ type: 'audio-error', description: detail })
      }
    }
  })

  test('no uncaught renderer errors during a typical session', async ({ vibedeck }) => {
    const { page, app } = vibedeck
    await completeFirstRun(page)
    const root = page.getByTestId('app-root')

    for (const mode of ['visualizer'] as const) {
      await expect(root).toHaveAttribute('data-mode', mode)
      // Let a few animation frames render in each mode.
      await page.waitForTimeout(400)
    }

    for (const tab of SETTINGS_TABS) await openSettingsTab(page, tab)
    await page.getByTestId('settings-close').press('Enter')
    await expect(page.getByTestId('settings-panel')).toHaveCount(0)

    await page.keyboard.press('F11')
    await expect.poll(() => isFullScreen(app)).toBe(true)
    await page.keyboard.press('Escape')
    await expect.poll(() => isFullScreen(app)).toBe(false)

    // Let async work (IPC round trips, artwork decode, toasts) settle before judging.
    await page.waitForTimeout(1500)

    const messages = vibedeck.pageErrors.map((e) => e.stack || e.message)
    expect(messages, 'renderer raised uncaught errors').toEqual([])
  })
})
