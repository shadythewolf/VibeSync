/**
 * Renderer audio entry point. The engine and the scheduler are process-wide singletons
 * that live for the whole session; switching visual modes never touches them.
 */
import { DEFAULT_SETTINGS } from '@shared/settings'
import { FrameScheduler } from '../visualizer/FrameScheduler'
import { AudioEngine } from './AudioEngine'
import {
  startBrowserCapture as startBrowserCaptureInto,
  stopBrowserCapture as stopBrowserCaptureImpl,
  isBrowserCaptureActive
} from './BrowserCaptureSource'
import type { IAudioEngine } from './types'
import type { IFrameScheduler } from '../visualizer/types'

export const audioEngine: IAudioEngine = new AudioEngine({
  audio: DEFAULT_SETTINGS.audio,
  visualizer: DEFAULT_SETTINGS.visualizer
})

export const frameScheduler: IFrameScheduler = new FrameScheduler(audioEngine)

/** Start the Chromium loopback fallback feeding the singleton engine. */
export function startBrowserCapture(): Promise<void> {
  return startBrowserCaptureInto(audioEngine)
}

/** Stop the Chromium loopback fallback. */
export function stopBrowserCapture(): void {
  stopBrowserCaptureImpl()
}

export { isBrowserCaptureActive }
export { AudioEngine, levelToDbfs, LEVEL_MIN_DB } from './AudioEngine'
export { FrameScheduler } from '../visualizer/FrameScheduler'
export { BrowserCaptureSource, BrowserCaptureError } from './BrowserCaptureSource'
export { FFT, hannWindow, magnitudeToDb } from './fft'
export { computeBandLayout, fillBands, bandEnergy } from './bands'
export type { BandLayout } from './bands'
export { BeatDetector } from './beat'
export { KeyEstimator } from './key'
export type { KeyEstimate } from './key'
export * from './types'
