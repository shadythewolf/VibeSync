/**
 * Playwright configuration for the VibeSync Electron e2e suite.
 *
 *   npm run build            # produces out/ (required)
 *   npm run test:e2e         # = playwright test -c tests/e2e/playwright.config.ts
 *
 * Electron owns the real window and the audio helper, so tests run strictly one at a time
 * (workers: 1) and never retry: a flaky pass would hide a real problem in the capture path.
 */
import { defineConfig } from '@playwright/test'
import path from 'node:path'

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  outputDir: path.join(PROJECT_ROOT, 'test-results', 'e2e'),
  // Keep every test's user-data directory (settings.json, logs/vibedeck.log) for inspection.
  preserveOutput: 'always'
})
