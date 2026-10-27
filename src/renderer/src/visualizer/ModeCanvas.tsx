/**
 * ModeCanvas hosts one ModeRenderer on a full-size <canvas>.
 *
 * - Sizes the backing store in device pixels, scales the context by dpr, and calls
 *   `renderer.resize()` when the element size changes (ResizeObserver).
 * - Registers one callback with the FrameScheduler; on each frame it builds a DrawContext
 *   from store snapshots (getState(), no React subscriptions) and calls `renderer.draw()`.
 * - Never causes React re-renders per frame.
 * - Recovers from GPU process loss: when the 2D context reports `contextlost`, or the main
 *   process signals a GPU reset (uiStore.canvasGeneration), the canvas element and the
 *   renderer (with all its cached offscreen surfaces) are re-created.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { audioEngine, frameScheduler } from '../audio'
import { getSettings } from '../store/settingsStore'
import { getTrackPositionMs, useTrackStore } from '../store/trackStore'
import { useUiStore } from '../store/uiStore'
import { resolveTheme } from './theme'
import type { DrawContext, ModeRenderer } from './types'

export interface ModeCanvasProps {
  /** Factory; called once per mount (and again after a GPU reset). */
  create: () => ModeRenderer
  className?: string
  style?: CSSProperties
  /** Use an opaque canvas (faster) when the mode paints its own background. Default true. */
  opaque?: boolean
  /** Cap device pixel ratio (default 2) to keep fill-rate sane on 4K displays. */
  maxDpr?: number
}

/** Delay before re-creating a canvas whose context was lost (lets the GPU process come back). */
const CONTEXT_LOST_REMOUNT_MS = 700

export function ModeCanvas({ create, className, style, opaque = true, maxDpr = 2 }: ModeCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const createRef = useRef(create)
  createRef.current = create
  const globalGeneration = useUiStore((s) => s.canvasGeneration)
  const [localGeneration, setLocalGeneration] = useState(0)
  const generation = globalGeneration + localGeneration
  // CPU rasterisation costs fill rate, so never render above 1 device pixel per CSS pixel
  // when hardware acceleration is off.
  const softwareRendering = useUiStore((s) => s.softwareRendering)
  const dprCap = softwareRendering ? 1 : maxDpr

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: !opaque })
    if (!ctx) return

    const renderer = createRef.current()
    let width = 0
    let height = 0
    let dpr = 1
    let disposed = false
    let remountTimer: ReturnType<typeof setTimeout> | null = null

    const dc: DrawContext = {
      ctx,
      width: 0,
      height: 0,
      dpr: 1,
      theme: resolveTheme(getSettings().colors, useTrackStore.getState().artworkPalette),
      settings: getSettings(),
      track: useTrackStore.getState().track,
      artwork: null,
      positionMs: 0,
      fps: 0
    }

    const applySize = (): void => {
      const rect = canvas.getBoundingClientRect()
      const w = Math.max(1, Math.round(rect.width))
      const h = Math.max(1, Math.round(rect.height))
      const nextDpr = Math.min(dprCap, Math.max(1, window.devicePixelRatio || 1))
      if (w === width && h === height && nextDpr === dpr) return
      width = w
      height = h
      dpr = nextDpr
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      dc.width = w
      dc.height = h
      dc.dpr = dpr
      renderer.resize?.(w, h, dpr)
    }
    applySize()

    const ro = new ResizeObserver(() => applySize())
    ro.observe(canvas)

    // Chromium fires these on 2D canvases when the GPU process dies. Re-create the whole
    // canvas + renderer instead of trusting the automatic restore (cached offscreen
    // surfaces would be blank anyway).
    const onContextLost = (e: Event): void => {
      e.preventDefault()
      if (disposed || remountTimer !== null) return
      remountTimer = setTimeout(() => {
        remountTimer = null
        if (!disposed) setLocalGeneration((g) => g + 1)
      }, CONTEXT_LOST_REMOUNT_MS)
    }
    canvas.addEventListener('contextlost', onContextLost)

    let lastPosNow = 0
    const unregister = frameScheduler.register((frame) => {
      if (width === 0 || height === 0) return
      const settings = getSettings()
      const ts = useTrackStore.getState()
      dc.settings = settings
      dc.theme = resolveTheme(settings.colors, ts.artworkPalette, frame.time)
      dc.track = ts.track
      dc.artwork = settings.visualizer.showAlbumArt ? ts.artwork : null
      // Date.now() is cheap but keep it to ~10 Hz for position interpolation.
      if (frame.time - lastPosNow > 100) {
        lastPosNow = frame.time
        dc.positionMs = getTrackPositionMs(ts.track)
      }
      dc.fps = frameScheduler.stats.fps
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      renderer.draw(frame, dc)
    })

    return () => {
      disposed = true
      if (remountTimer !== null) clearTimeout(remountTimer)
      canvas.removeEventListener('contextlost', onContextLost)
      unregister()
      ro.disconnect()
      renderer.dispose?.()
    }
  }, [opaque, dprCap, generation])

  return (
    <canvas
      key={generation}
      ref={canvasRef}
      className={className}
      style={{ display: 'block', width: '100%', height: '100%', ...style }}
      aria-hidden="true"
    />
  )
}

/** Expose the engine for modes that need to read the frame outside the draw callback (rare). */
export { audioEngine }
