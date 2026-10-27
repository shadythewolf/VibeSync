/**
 * FrameScheduler - the single requestAnimationFrame loop of the renderer.
 *
 * Each rendered frame:
 *   1. `audioEngine.update(now)` exactly once
 *   2. every registered callback `(frame, dt, now)` inside its own try/catch - a
 *      throwing mode renderer never kills the loop (errors are logged at most once
 *      per 5 s per message through window.vibedeck.app.log)
 *
 * The fps limit (0 = uncapped) skips rAF ticks until at least (1000 / limit - 1) ms
 * have elapsed since the previous rendered frame. The loop pauses while the document
 * is hidden and resumes without a huge dt (the first frame after resume uses 1/60 s).
 */
import type { AnalysisFrame, IAudioEngine } from '../audio/types'
import type { FrameSchedulerStats, IFrameScheduler } from './types'

type FrameCallback = (frame: AnalysisFrame, dt: number, now: number) => void

const LOG_THROTTLE_MS = 5000
const FPS_EMA = 0.1
const FRAME_TIME_EMA = 0.1
const NOMINAL_FRAME_MS = 1000 / 60
/** Frames arriving later than this multiple of the expected interval count as dropped. */
const DROP_FACTOR = 1.5

function perfNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

export class FrameScheduler implements IFrameScheduler {
  readonly stats: FrameSchedulerStats = { fps: 0, frameTimeMs: 0, droppedFrames: 0 }

  private readonly engine: IAudioEngine
  private callbacks: FrameCallback[] = []
  private fpsLimit = 0
  private running = false
  private rafId = 0
  private timerId: ReturnType<typeof setTimeout> | null = null
  private lastRenderTime = -1
  /** True right after start / resume so the first frame does not see a giant dt. */
  private justResumed = true
  private readonly lastLogAt = new Map<string, number>()
  private readonly hasRaf: boolean
  private readonly hasDocument: boolean
  private visibilityListener: (() => void) | null = null
  /** Externally requested pause (window hidden to the tray or minimized). */
  private paused = false

  constructor(engine: IAudioEngine) {
    this.engine = engine
    this.hasRaf = typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function'
    this.hasDocument = typeof document !== 'undefined' && typeof document.addEventListener === 'function'
  }

  register(fn: FrameCallback): () => void {
    if (typeof fn !== 'function') return () => {}
    // Immutable swap so a callback that unregisters during iteration cannot corrupt the loop.
    this.callbacks = [...this.callbacks, fn]
    return () => {
      this.callbacks = this.callbacks.filter((f) => f !== fn)
    }
  }

  setFpsLimit(fps: number): void {
    this.fpsLimit = Number.isFinite(fps) && fps > 0 ? fps : 0
  }

  /**
   * Pause / resume the loop for reasons the page cannot see. With backgroundThrottling
   * disabled a window hidden to the tray still reports `visibilityState: 'visible'` and
   * keeps receiving animation frames, so the main process tells us when it is really gone.
   */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    if (paused) {
      this.cancelPending()
      return
    }
    this.justResumed = true
    this.lastRenderTime = -1
    if (this.running && !(this.hasDocument && document.hidden)) this.schedule()
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.justResumed = true
    this.lastRenderTime = -1
    if (this.hasDocument && !this.visibilityListener) {
      this.visibilityListener = () => this.onVisibilityChange()
      document.addEventListener('visibilitychange', this.visibilityListener)
    }
    if (this.hasDocument && document.hidden) return // resumes on visibilitychange
    if (this.paused) return // resumes on setPaused(false)
    this.schedule()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.cancelPending()
    if (this.hasDocument && this.visibilityListener) {
      document.removeEventListener('visibilitychange', this.visibilityListener)
      this.visibilityListener = null
    }
  }

  // ---------------------------------------------------------------------------

  private schedule(): void {
    if (!this.running || this.paused) return
    if (this.hasRaf) {
      if (this.rafId !== 0) return
      this.rafId = requestAnimationFrame(this.tick)
    } else if (this.timerId === null) {
      // Non-browser environment (tests): emulate ~60 Hz with timers.
      this.timerId = setTimeout(() => {
        this.timerId = null
        this.tick(perfNow())
      }, NOMINAL_FRAME_MS)
    }
  }

  private cancelPending(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
    if (this.timerId !== null) {
      clearTimeout(this.timerId)
      this.timerId = null
    }
  }

  private onVisibilityChange(): void {
    if (!this.running) return
    if (document.hidden) {
      this.cancelPending()
    } else {
      this.justResumed = true
      this.lastRenderTime = -1
      this.schedule()
    }
  }

  private readonly tick = (now: number): void => {
    this.rafId = 0
    if (!this.running) return
    if (this.hasDocument && document.hidden) return // paused; visibilitychange resumes
    this.schedule()

    if (this.fpsLimit > 0 && this.lastRenderTime >= 0) {
      const minInterval = 1000 / this.fpsLimit - 1
      if (now - this.lastRenderTime < minInterval) return
    }

    const dtMs = this.lastRenderTime >= 0 && !this.justResumed ? now - this.lastRenderTime : NOMINAL_FRAME_MS
    this.justResumed = false
    this.lastRenderTime = now

    const expected = this.fpsLimit > 0 ? 1000 / this.fpsLimit : NOMINAL_FRAME_MS
    if (dtMs > expected * DROP_FACTOR) {
      const missed = Math.round(dtMs / expected) - 1
      if (missed > 0) this.stats.droppedFrames += missed > 1000 ? 1000 : missed
    }

    const t0 = perfNow()
    try {
      this.engine.update(now)
    } catch (err) {
      this.logError('AudioEngine.update failed', err)
    }
    const frame = this.engine.frame
    const dt = frame.dt
    const cbs = this.callbacks
    for (let i = 0; i < cbs.length; i++) {
      try {
        cbs[i](frame, dt, now)
      } catch (err) {
        this.logError('Frame callback failed', err)
      }
    }
    const elapsed = perfNow() - t0
    const stats = this.stats
    stats.frameTimeMs = stats.frameTimeMs === 0 ? elapsed : stats.frameTimeMs + (elapsed - stats.frameTimeMs) * FRAME_TIME_EMA
    const instFps = 1000 / (dtMs < 1 ? 1 : dtMs)
    stats.fps = stats.fps === 0 ? instFps : stats.fps + (instFps - stats.fps) * FPS_EMA
  }

  private logError(message: string, err: unknown): void {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    const key = `${message}|${err instanceof Error ? err.message : detail}`
    const now = perfNow()
    const last = this.lastLogAt.get(key)
    if (last !== undefined && now - last < LOG_THROTTLE_MS) return
    this.lastLogAt.set(key, now)
    if (this.lastLogAt.size > 64) {
      // keep the map bounded
      const oldest = this.lastLogAt.keys().next().value
      if (oldest !== undefined) this.lastLogAt.delete(oldest)
    }
    try {
      const w = typeof window !== 'undefined' ? window : undefined
      if (w?.vibedeck) {
        w.vibedeck.app.log('error', message, detail)
        return
      }
    } catch {
      /* fall through */
    }
    console.error(`[FrameScheduler] ${message}`, detail)
  }
}

export default FrameScheduler
