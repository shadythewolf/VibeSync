/**
 * Keeps VibeSync usable on machines with an unstable GPU stack.
 *
 * Chromium runs the visualizer's canvases on a separate GPU process. When that process
 * dies repeatedly (a bad driver, an injected overlay, a virtual display adapter) Chromium
 * gives up with "GPU process isn't usable. Goodbye." and takes the whole app with it -
 * the user just sees the window vanish a second after launch.
 *
 * The guard:
 *   1. `applyGpuPreference()` runs BEFORE app.whenReady() and turns hardware acceleration
 *      off for this launch when the user (or a previous fallback) asked for it. Canvas2D
 *      then renders on the CPU, which is slower but always works.
 *   2. `noteGpuCrash()` counts GPU process deaths. After GPU_CRASH_LIMIT of them the
 *      preference is persisted as "off" and the app relaunches itself immediately -
 *      Chromium's own give-up threshold is only a few crashes apart, so there is no time
 *      to ask the user first. The next launch comes up in software mode and says so.
 *
 * Turning hardware acceleration back on is a single toggle in Settings > General.
 */
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateSettings, type Settings } from '../shared/settings'
import { log } from './logger'
import { settingsStore } from './settingsStore'

/** GPU process deaths in one session before we fall back to software rendering. */
const GPU_CRASH_LIMIT = 3
/** Argument added to the relaunch so the new instance can explain itself. */
export const GPU_FALLBACK_ARG = '--gpu-fallback'

let hardwareAcceleration = true
let fallbackApplied = false
let crashes = 0
let relaunching = false

/**
 * Read settings.json without touching the store: this runs before `app.whenReady()` and
 * before the logger exists, so it must not throw, log or schedule a save.
 */
function readSettingsEarly(): Settings | null {
  try {
    const raw = readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8')
    return validateSettings(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

/** Call once before `app.whenReady()`. Returns true when the GPU is in use this launch. */
export function applyGpuPreference(argv: readonly string[]): boolean {
  fallbackApplied = argv.includes(GPU_FALLBACK_ARG)
  const settings = readSettingsEarly()
  hardwareAcceleration = settings ? settings.general.hardwareAcceleration : true
  if (!hardwareAcceleration) {
    app.disableHardwareAcceleration()
  }
  return hardwareAcceleration
}

/**
 * Whether the GPU is really doing the work. This is not just the setting: Chromium also
 * falls back to SwiftShader on its own when a driver is blocklisted or a command-line flag
 * disables the GPU, and the renderer needs to know so it can lower its pixel budget.
 * Only meaningful after `app.whenReady()`.
 */
export function isHardwareAccelerationEnabled(): boolean {
  if (!hardwareAcceleration) return false
  try {
    const status = app.getGPUFeatureStatus() as unknown as Record<string, string | undefined>
    const compositing = status.gpu_compositing ?? ''
    const canvas = status['2d_canvas'] ?? ''
    if (compositing.includes('software') || compositing.includes('disabled')) return false
    if (canvas.includes('software')) return false
    return true
  } catch {
    return hardwareAcceleration
  }
}

/** True when this launch is the automatic software-rendering fallback. */
export function wasGpuFallbackApplied(): boolean {
  return fallbackApplied
}

/**
 * Record a GPU process crash. Returns true when the app is relaunching into software
 * rendering (callers should stop what they are doing).
 */
export function noteGpuCrash(reason: string, exitCode: number): boolean {
  if (!hardwareAcceleration || relaunching) return relaunching
  crashes += 1
  log('warn', `GPU process crashed (${reason}, exit code ${exitCode}) - ${crashes}/${GPU_CRASH_LIMIT} before software fallback`)
  if (crashes < GPU_CRASH_LIMIT) return false

  relaunching = true
  log('error', 'Repeated GPU process crashes; restarting VibeSync with hardware acceleration disabled')
  try {
    settingsStore.set({ general: { hardwareAcceleration: false } })
    settingsStore.flushSync()
  } catch (err) {
    log('error', 'Could not persist the hardware-acceleration fallback', err)
  }
  const args = process.argv.slice(1).filter((a) => a !== GPU_FALLBACK_ARG)
  args.push(GPU_FALLBACK_ARG)
  try {
    app.relaunch({ args })
  } catch (err) {
    log('error', 'Could not schedule the relaunch', err)
  }
  app.exit(0)
  return true
}
