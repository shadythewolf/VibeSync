/**
 * Contract between the visual modes and the rendering infrastructure.
 *
 * One FrameScheduler drives a single requestAnimationFrame loop. Each mounted
 * mode registers its canvas draw callbacks with the scheduler; the scheduler
 * calls `AudioEngine.update()` once, then every registered draw callback with
 * the same AnalysisFrame. Nothing in this pipeline goes through React state.
 */
import type { Settings } from '@shared/settings'
import type { TrackInfo } from '@shared/types'
import type { AnalysisFrame } from '../audio/types'

/** Extracted colours with their measured cover-area shares. */
export type ArtworkPalette = string[] & { weights?: number[] }

/** Resolved colour theme derived from ColorSettings (see visualizer/theme.ts). */
export interface ResolvedTheme {
  /** Gradient stops (CSS colours) from low frequency -> high frequency. */
  stops: string[]
  /** Actual gradient anchors; mixed artwork limits neutral coverage without a fixed position. */
  gradientStops: { color: string; position: number }[]
  primary: string
  secondary: string
  /** Third accent (derived) for highlights. */
  accent: string
  /** Text colours. */
  text: string
  textDim: string
  /** Panel and border colours. */
  panel: string
  border: string
  /** Background base colour (very dark). */
  background: string
  backgroundIntensity: number
  glowStrength: number
  /** Colour for a normalised position t (0 = low freq / bottom, 1 = high freq / top). */
  colorAt(t: number): string
  /** Colour at t with alpha 0..1. */
  colorAtAlpha(t: number, alpha: number): string
  /** Colour for a bar index out of barCount (handles rainbow modes that cycle). */
  barColor(index: number, count: number, level: number): string
  /** Per-bar white sheen strength for artwork, cached with the colour lookup. */
  barSheenOpacity?(index: number, count: number): number
  /** Fill a CanvasGradient across the given rectangle using the stops. */
  gradient(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, alpha?: number): CanvasGradient
}

export interface DrawContext {
  ctx: CanvasRenderingContext2D
  /** CSS pixel size of the canvas (context is already scaled by dpr). */
  width: number
  height: number
  dpr: number
  theme: ResolvedTheme
  settings: Settings
  track: TrackInfo
  /** Decoded album artwork, null when unavailable or disabled. */
  artwork: HTMLImageElement | null
  /** Interpolated playback position in ms (0 when unknown). */
  positionMs: number
  /** Measured render FPS. */
  fps: number
}

export type DrawFn = (frame: AnalysisFrame, dc: DrawContext) => void

/** A visual mode renderer draws onto one canvas. */
export interface ModeRenderer {
  /** Called when the canvas size changes (CSS pixels). */
  resize?(width: number, height: number, dpr: number): void
  draw: DrawFn
  dispose?(): void
}

export interface FrameSchedulerStats {
  fps: number
  frameTimeMs: number
  droppedFrames: number
}

export interface IFrameScheduler {
  /** Register a per-frame callback; returns unsubscribe. */
  register(fn: (frame: AnalysisFrame, dt: number, now: number) => void): () => void
  setFpsLimit(fps: number): void
  /** Pause the loop while the window is hidden to the tray or minimized. */
  setPaused(paused: boolean): void
  readonly stats: FrameSchedulerStats
  start(): void
  stop(): void
}
