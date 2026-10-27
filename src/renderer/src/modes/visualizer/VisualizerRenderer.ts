/**
 * VisualizerRenderer - the fullscreen visualizer.
 *
 * Pipeline per frame (everything derives from the real AnalysisFrame):
 *   1. background: near-black fill + a reactive radial glow (pre-rendered colour sprites,
 *      hue follows the spectral centroid, size/alpha follow bassImpact) - no per-frame gradients
 *   2. bar layer (offscreen, full resolution): spectrum bars from frame.bars with peak caps
 *      from frame.peaks, a cached vertical sheen (source-atop), the
 *      reflection (self drawImage flipped + cached destination-out fade), the waveform and
 *      the particle pool
 *   3. composite: the bar layer is drawn with a bass-driven zoom (1.0 - 1.06) around the
 *      baseline; when glow is on the layer is downsampled to 1/4 resolution with a blur
 *      filter and composited behind the opaque bars with 'lighter' so bloom cannot wash
 *      out their colours (alpha scaled by theme.glowStrength)
 *   4. a cached vignette scaled by backgroundIntensity
 *
 * Gradients and sprites are cached per (size, theme.stops, barCount, mirror, reflection,
 * barWidth, barSpacing) and rebuilt only when one of those changes. `draw()` allocates
 * nothing (colour strings come from the theme LUT).
 */
import type { AnalysisFrame } from '@renderer/audio'
import type { DrawContext, ModeRenderer, ResolvedTheme } from '@renderer/visualizer/types'
import type { VisualizerSettings } from '@shared/settings'
import { ParticleSystem } from './particles'

/** Bar layer -> glow layer downscale factor. */
const GLOW_DOWNSCALE = 4
/** Blur applied when compositing the (already blurred) low-res glow back at full size. */
const GLOW_COMPOSITE_FILTER = 'blur(3px)'
const GLOW_SPRITE_SIZE = 256
/** Number of pre-rendered background glow colours along the palette. */
const GLOW_BUCKETS = 24
const MAX_ZOOM = 1.06
/** Tallest bar as a fraction of the canvas height. */
const BAR_AREA = 0.7
const PARTICLE_CAPACITY = 240
/** Longest dt (s) we integrate; anything longer is a hitch/resume and is clamped. */
const MAX_DT = 0.1

interface Layout {
  /** y of the bar baseline (CSS px). */
  baseY: number
  /** y of the tallest possible bar top. */
  top: number
  maxBarH: number
  /** Height of the reflection below the baseline (0 when off). */
  reflH: number
  /** Width of one bar slot; when mirrored, half the canvas is divided by barCount. */
  slot: number
  /** Space reserved for the maximum horizontal bass zoom. */
  inset: number
  barW: number
  /** Left padding inside a slot so the bar is centred. */
  pad: number
  /** Peak-cap height. */
  capH: number
}

function clamp01(v: number): number {
  return v <= 0 || v !== v ? 0 : v >= 1 ? 1 : v
}

/** Fraction of the remaining distance covered by an exponential approach with `rate` 1/s over dt. */
function approach(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt)
}

export class VisualizerRenderer implements ModeRenderer {
  private width = 0
  private height = 0
  private dpr = 1
  private disposed = false

  private readonly barCanvas: HTMLCanvasElement
  private readonly barCtx: CanvasRenderingContext2D
  private readonly glowCanvas: HTMLCanvasElement
  private readonly glowCtx: CanvasRenderingContext2D
  private glowW = 1
  private glowH = 1
  private glowLowResFilter = 'blur(5px)'
  private readonly hasRoundRect: boolean
  /** Reused radii array for roundRect (top corners only). */
  private readonly radii: number[] = [0, 0, 0, 0]

  // ---- cache keys -----------------------------------------------------------------
  private sizeDirty = true
  private cachedStops: readonly string[] | null = null
  private cachedN = -1
  private cachedMirror = false
  private cachedReflection = false
  private cachedBarWidth = -1
  private cachedBarSpacing = -1

  private readonly layout: Layout = { baseY: 0, top: 0, maxBarH: 0, reflH: 0, inset: 0, slot: 1, barW: 1, pad: 0, capH: 2 }
  private sheen: CanvasGradient | null = null
  private reflectionFade: CanvasGradient | null = null
  private vignette: CanvasGradient | null = null
  private waveGradient: CanvasGradient | null = null
  private glowSprites: HTMLCanvasElement[] = []
  private glowSpriteStops: readonly string[] | null = null

  // ---- dynamics (smoothed across frames) ------------------------------------------
  /** Spectral centroid mapped onto the palette (0 = first stop, 1 = last stop). */
  private hueT = 0.35
  /** Smoothed bass impact 0..1 (fast attack, slower release). */
  private bass = 0
  private zoom = 1
  /** 1 while audio flows, eases to 0 when it stops (bars settle, glow breathes). */
  private idleFade = 0
  private breathe = 0
  private dt = 1 / 60
  private spawnAcc = 0
  private spawnCursor = 0
  private readonly particles = new ParticleSystem(PARTICLE_CAPACITY)

  constructor() {
    this.barCanvas = document.createElement('canvas')
    const bctx = this.barCanvas.getContext('2d')
    if (!bctx) throw new Error('VisualizerRenderer: could not create the bar layer 2D context')
    this.barCtx = bctx
    this.glowCanvas = document.createElement('canvas')
    const gctx = this.glowCanvas.getContext('2d')
    if (!gctx) throw new Error('VisualizerRenderer: could not create the glow layer 2D context')
    this.glowCtx = gctx
    this.hasRoundRect = typeof bctx.roundRect === 'function'
  }

  resize(width: number, height: number, dpr: number): void {
    if (this.disposed) return
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
    this.width = w
    this.height = h
    this.dpr = d

    this.barCanvas.width = Math.max(1, Math.round(w * d))
    this.barCanvas.height = Math.max(1, Math.round(h * d))
    // Setting width/height resets the context state, so re-apply the dpr transform.
    this.barCtx.setTransform(d, 0, 0, d, 0, 0)

    this.glowW = Math.max(1, Math.ceil(w / GLOW_DOWNSCALE))
    this.glowH = Math.max(1, Math.ceil(h / GLOW_DOWNSCALE))
    this.glowCanvas.width = this.glowW
    this.glowCanvas.height = this.glowH
    this.glowCtx.setTransform(1, 0, 0, 1, 0, 0)
    this.glowCtx.imageSmoothingEnabled = true
    // ~20-36 px of bloom at full resolution, computed on 1/16 of the pixels.
    this.glowLowResFilter = `blur(${Math.max(3, Math.min(9, Math.round(this.glowW * 0.012)))}px)`

    this.sizeDirty = true
    this.particles.clear()
  }

  draw(frame: AnalysisFrame, dc: DrawContext): void {
    if (this.disposed) return
    const { ctx, width, height, theme, settings } = dc
    if (width !== this.width || height !== this.height || dc.dpr !== this.dpr) this.resize(width, height, dc.dpr)
    if (this.width < 2 || this.height < 2) return

    const vs = settings.visualizer
    const n = frame.bars.length
    this.ensureLayout(theme, vs, n)
    this.ensureGlowSprites(theme)
    this.advance(frame)

    this.drawBackground(ctx, frame, theme)
    this.drawBarLayer(frame, theme, vs, n)
    this.compositeBars(ctx, frame, theme, vs)
    this.drawVignette(ctx, theme)
  }

  dispose(): void {
    this.disposed = true
    this.particles.clear()
    this.barCanvas.width = 0
    this.barCanvas.height = 0
    this.glowCanvas.width = 0
    this.glowCanvas.height = 0
    for (const c of this.glowSprites) {
      c.width = 0
      c.height = 0
    }
    this.glowSprites.length = 0
    this.glowSpriteStops = null
    this.sheen = null
    this.reflectionFade = null
    this.vignette = null
    this.waveGradient = null
  }

  // =====================================================================================
  // Dynamics
  // =====================================================================================

  private advance(frame: AnalysisFrame): void {
    const dt = frame.dt > 0 && frame.dt < MAX_DT ? frame.dt : 1 / 60
    this.dt = dt
    const hasSignal = frame.hasSignal

    // Bars/glow ease out over ~1 s when audio stops and snap back quickly when it returns.
    this.idleFade += ((hasSignal ? 1 : 0) - this.idleFade) * approach(hasSignal ? 10 : 1.8, dt)
    if (this.idleFade < 0.001) this.idleFade = 0
    else if (this.idleFade > 0.999) this.idleFade = 1

    // Spectral centroid -> palette position. Bass-heavy content pulls toward the first
    // stops, bright content toward the last.
    const e = frame.bass + frame.mid + frame.treble
    if (hasSignal && e > 1e-3) {
      const target = clamp01((frame.mid * 0.5 + frame.treble) / e)
      this.hueT += (target - this.hueT) * approach(2.5, dt)
    }

    // Fast bass envelope: attack in a couple of frames, release over ~150 ms.
    const bTarget = hasSignal ? clamp01(frame.bassImpact) : 0
    this.bass += (bTarget - this.bass) * approach(bTarget > this.bass ? 30 : 7, dt)
    if (this.bass < 0.001) this.bass = 0
    this.zoom = 1 + (MAX_ZOOM - 1) * Math.pow(this.bass, 1.3) * this.idleFade

    // Slow deterministic breathing for the idle state (from the frame clock, not random).
    this.breathe = 0.5 + 0.5 * Math.sin(frame.time * 0.0016)
  }

  // =====================================================================================
  // Caches
  // =====================================================================================

  private ensureLayout(theme: ResolvedTheme, vs: VisualizerSettings, n: number): void {
    if (
      !this.sizeDirty &&
      this.cachedStops === theme.stops &&
      this.cachedN === n &&
      this.cachedMirror === vs.mirror &&
      this.cachedReflection === vs.reflection &&
      this.cachedBarWidth === vs.barWidth &&
      this.cachedBarSpacing === vs.barSpacing
    ) {
      return
    }
    this.sizeDirty = false
    this.cachedStops = theme.stops
    this.cachedN = n
    this.cachedMirror = vs.mirror
    this.cachedReflection = vs.reflection
    this.cachedBarWidth = vs.barWidth
    this.cachedBarSpacing = vs.barSpacing

    const w = this.width
    const h = this.height
    const L = this.layout
    L.baseY = Math.round(h * (vs.reflection ? 0.74 : 0.9))
    L.maxBarH = Math.max(1, Math.min(Math.round(h * BAR_AREA), L.baseY - Math.round(h * 0.05)))
    L.top = L.baseY - L.maxBarH
    L.reflH = vs.reflection ? Math.max(0, Math.min(h - L.baseY, Math.round(L.maxBarH * 0.45))) : 0
    L.inset=(w-w/MAX_ZOOM)*0.5+Math.min(4,w*0.01)
    const usableWidth=Math.max(1,w-2*L.inset)
    const span = vs.mirror ? usableWidth * 0.5 : usableWidth
    L.slot = n > 0 ? span / n : span
    L.barW = Math.max(1, L.slot * vs.barWidth - vs.barSpacing)
    L.pad = (L.slot - L.barW) * 0.5
    L.capH = Math.max(2, Math.min(4, Math.round(L.barW * 0.3)))

    const b = this.barCtx
    // Vertical sheen: hot tips, grounded base (applied with source-atop over the bars).
    const sheen = b.createLinearGradient(0, L.top, 0, L.baseY)
    sheen.addColorStop(0, 'rgba(255,255,255,0.40)')
    sheen.addColorStop(0.3, 'rgba(255,255,255,0.08)')
    sheen.addColorStop(0.7, 'rgba(0,0,0,0)')
    sheen.addColorStop(1, 'rgba(0,0,0,0.38)')
    this.sheen = sheen

    // Reflection fade (destination-out): the alpha is the fraction removed.
    const fade = b.createLinearGradient(0, L.baseY, 0, L.baseY + Math.max(1, L.reflH))
    fade.addColorStop(0, 'rgba(0,0,0,0.30)')
    fade.addColorStop(0.5, 'rgba(0,0,0,0.78)')
    fade.addColorStop(1, 'rgba(0,0,0,1)')
    this.reflectionFade = fade

    // Waveform stroke: the palette across the width (mirrored from the centre when mirror is on).
    if (vs.mirror) {
      const g = b.createLinearGradient(0, 0, w, 0)
      for (const { color, position } of theme.gradientStops) {
        g.addColorStop(0.5 + 0.5 * position, color)
        g.addColorStop(0.5 - 0.5 * position, color)
      }
      this.waveGradient = g
    } else {
      this.waveGradient = theme.gradient(b, 0, 0, w, 0)
    }

    const rMax = Math.hypot(w, h) * 0.5
    const vig = b.createRadialGradient(w * 0.5, h * 0.5, rMax * 0.45, w * 0.5, h * 0.5, rMax * 1.05)
    vig.addColorStop(0, 'rgba(0,0,0,0)')
    vig.addColorStop(0.6, 'rgba(0,0,0,0.35)')
    vig.addColorStop(1, 'rgba(0,0,0,0.92)')
    this.vignette = vig
  }

  /** Pre-render one soft radial blob per palette bucket so the background glow needs no per-frame gradient. */
  private ensureGlowSprites(theme: ResolvedTheme): void {
    if (this.glowSpriteStops === theme.stops && this.glowSprites.length === GLOW_BUCKETS) return
    this.glowSpriteStops = theme.stops
    const size = GLOW_SPRITE_SIZE
    const half = size / 2
    for (let bkt = 0; bkt < GLOW_BUCKETS; bkt++) {
      let c = this.glowSprites[bkt]
      if (!c) {
        c = document.createElement('canvas')
        this.glowSprites[bkt] = c
      }
      c.width = size
      c.height = size
      const g = c.getContext('2d')
      if (!g) continue
      const t = bkt / (GLOW_BUCKETS - 1)
      const grad = g.createRadialGradient(half, half, 0, half, half, half)
      grad.addColorStop(0, theme.colorAtAlpha(t, 0.85))
      grad.addColorStop(0.22, theme.colorAtAlpha(t, 0.48))
      grad.addColorStop(0.55, theme.colorAtAlpha(t, 0.14))
      grad.addColorStop(1, theme.colorAtAlpha(t, 0))
      g.clearRect(0, 0, size, size)
      g.fillStyle = grad
      g.fillRect(0, 0, size, size)
    }
    this.glowSprites.length = GLOW_BUCKETS
  }

  // =====================================================================================
  // Passes
  // =====================================================================================

  private drawBackground(ctx: CanvasRenderingContext2D, frame: AnalysisFrame, theme: ResolvedTheme): void {
    const w = this.width
    const h = this.height
    ctx.fillStyle = theme.background
    ctx.fillRect(0, 0, w, h)

    const bi = theme.backgroundIntensity
    if (bi <= 0 || this.glowSprites.length !== GLOW_BUCKETS) return

    const live = this.idleFade
    const idle = 1 - live
    const loud = clamp01(frame.loudness)
    const alpha = bi * (live * (0.26 + 0.3 * loud + 0.6 * this.bass) + idle * (0.16 + 0.14 * this.breathe))
    if (alpha <= 0.003) return
    const rMax = Math.max(w, h)
    const radius = rMax * (live * (0.4 + 0.3 * this.bass + 0.1 * loud) + idle * (0.36 + 0.06 * this.breathe))

    const f = this.hueT * (GLOW_BUCKETS - 1)
    const a = Math.floor(f)
    const b = a + 1 < GLOW_BUCKETS ? a + 1 : a
    const frac = f - a
    const cx = w * 0.5
    const cy = this.layout.baseY

    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = Math.min(1, alpha * (1 - frac))
    ctx.drawImage(this.glowSprites[a], cx - radius, cy - radius, radius * 2, radius * 2)
    if (frac > 0.002) {
      ctx.globalAlpha = Math.min(1, alpha * frac)
      ctx.drawImage(this.glowSprites[b], cx - radius, cy - radius, radius * 2, radius * 2)
    }
    // Faint complementary glow high in the frame for a two-tone depth.
    const c = Math.round((1 - this.hueT) * (GLOW_BUCKETS - 1))
    const r2 = radius * 1.35
    ctx.globalAlpha = Math.min(1, alpha * 0.28)
    ctx.drawImage(this.glowSprites[c], cx - r2, this.layout.top * 0.5 - r2, r2 * 2, r2 * 2)

    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  private drawBarLayer(frame: AnalysisFrame, theme: ResolvedTheme, vs: VisualizerSettings, n: number): void {
    const b = this.barCtx
    const w = this.width
    const h = this.height
    const L = this.layout
    b.clearRect(0, 0, w, h)
    if (n === 0) return

    const bars = frame.bars
    const peaks = frame.peaks
    const fade = this.idleFade
    const mirror = vs.mirror
    const rounded = vs.roundedBars && this.hasRoundRect
    const cx = w * 0.5
    /** Tiny pill at the baseline while audio flows, so quiet bands still read as a row. */
    const floor = Math.min(2, L.barW) * fade

    // ---- bars + peak caps ---------------------------------------------------------------
    for (let i = 0; i < n; i++) {
      const lvl = clamp01(bars[i]) * fade
      let bh = lvl * L.maxBarH
      if (bh < floor) bh = floor
      const pk = clamp01(peaks[i]) * fade
      const hasCap = pk > lvl + 0.01 && pk > 0.02
      if (bh <= 0 && !hasCap) continue
      const off = i * L.slot + L.pad

      if (bh > 0) {
        b.fillStyle = theme.barColor(i, n, lvl)
        if (mirror) {
          this.fillBar(b, cx + off, L.baseY - bh, L.barW, bh, rounded)
          this.fillBar(b, cx - off - L.barW, L.baseY - bh, L.barW, bh, rounded)
        } else {
          this.fillBar(b, L.inset + off, L.baseY - bh, L.barW, bh, rounded)
        }
      }
      if (hasCap) {
        const py = L.baseY - pk * L.maxBarH - L.capH - 2
        b.fillStyle = theme.barColor(i, n, 1)
        if (mirror) {
          b.fillRect(cx + off, py, L.barW, L.capH)
          b.fillRect(cx - off - L.barW, py, L.barW, L.capH)
        } else {
          b.fillRect(L.inset + off, py, L.barW, L.capH)
        }
      }
    }

    // ---- static sheen (only where bars were painted) -------------------------
    b.globalCompositeOperation = 'source-atop'
    if (this.sheen) {
      b.fillStyle = this.sheen
      if (theme.barSheenOpacity) {
        for(let i=0;i<n;i++) {
          b.globalAlpha=theme.barSheenOpacity(i,n)
          const off=i*L.slot+L.pad
          if(mirror) {
            b.fillRect(cx+off,L.top-6,L.barW,L.baseY-L.top+6)
            b.fillRect(cx-off-L.barW,L.top-6,L.barW,L.baseY-L.top+6)
          } else b.fillRect(L.inset+off,L.top-6,L.barW,L.baseY-L.top+6)
        }
        b.globalAlpha=1
      } else b.fillRect(0, L.top - 6, w, L.baseY - L.top + 6)
    }
    b.globalCompositeOperation = 'source-over'

    // ---- reflection: the bottom of the bar area mirrored below the baseline --------------
    if (vs.reflection && L.reflH > 0 && this.reflectionFade) {
      const d = this.dpr
      b.save()
      b.globalAlpha = 0.5
      b.translate(0, L.baseY)
      b.scale(1, -1)
      b.drawImage(
        this.barCanvas,
        0,
        Math.round((L.baseY - L.reflH) * d),
        Math.round(w * d),
        Math.max(1, Math.round(L.reflH * d)),
        0,
        -L.reflH,
        w,
        L.reflH
      )
      b.restore()
      b.globalCompositeOperation = 'destination-out'
      b.fillStyle = this.reflectionFade
      b.fillRect(0, L.baseY, w, L.reflH + 1)
      b.globalCompositeOperation = 'source-over'
    }

    // ---- waveform across the vertical centre --------------------------------------------
    if (vs.showWaveform && fade > 0.01 && this.waveGradient) this.drawWaveform(b, frame, mirror)

    // ---- particles ------------------------------------------------------------------------
    if (vs.particles) {
      this.spawnParticles(frame, mirror, n)
      const s = h / 1080
      this.particles.update(this.dt, w, h, 26 * s, 0.9)
      this.particles.draw(b, theme, 0.95)
    } else if (this.particles.count > 0) {
      this.particles.clear()
    }
  }

  private fillBar(b: CanvasRenderingContext2D, x: number, y: number, bw: number, bh: number, rounded: boolean): void {
    if (rounded && bw >= 2 && bh >= 1) {
      const r = Math.min(bw * 0.5, bh * 0.5)
      const radii = this.radii
      radii[0] = r
      radii[1] = r
      b.beginPath()
      b.roundRect(x, y, bw, bh, radii)
      b.fill()
    } else {
      b.fillRect(x, y, bw, bh)
    }
  }

  private drawWaveform(b: CanvasRenderingContext2D, frame: AnalysisFrame, mirror: boolean): void {
    const wf = frame.waveform
    const len = wf.length
    if (len < 2) return
    const w = this.width
    const h = this.height
    const yMid = h * 0.5
    const amp = h * 0.1 * this.idleFade * (0.75 + 0.25 * this.bass)
    const span = mirror ? w * 0.5 : w
    // Roughly one sample per 1.5 px; stride through frame.waveform at small widths.
    const stride = Math.max(1, Math.floor(len / Math.max(64, span / 1.5)))
    const step = span / (len - 1)
    const cx = w * 0.5

    b.beginPath()
    if (mirror) {
      // Left half runs from the edge in to the centre (sample len-1 -> 0), right half back out.
      let first = true
      for (let i = len - 1; i >= 0; i -= stride) {
        const x = cx - i * step
        const y = yMid - wf[i] * amp
        if (first) {
          b.moveTo(x, y)
          first = false
        } else b.lineTo(x, y)
      }
      for (let i = 0; i < len; i += stride) b.lineTo(cx + i * step, yMid - wf[i] * amp)
    } else {
      b.moveTo(0, yMid - wf[0] * amp)
      for (let i = stride; i < len; i += stride) b.lineTo(i * step, yMid - wf[i] * amp)
    }
    b.lineJoin = 'round'
    b.lineCap = 'round'
    b.strokeStyle = this.waveGradient as CanvasGradient
    // Wide faint halo first, then the crisp core; the bloom pass adds the rest.
    b.globalAlpha = 0.22 * this.idleFade
    b.lineWidth = 6
    b.stroke()
    b.globalAlpha = 0.9 * this.idleFade
    b.lineWidth = 1.75
    b.stroke()
    b.globalAlpha = 1
  }

  private spawnParticles(frame: AnalysisFrame, mirror: boolean, n: number): void {
    if (!frame.hasSignal || n === 0 || this.idleFade < 0.5) {
      this.spawnAcc = 0
      return
    }
    const energy = clamp01(frame.bassImpact * 0.7 + frame.loudness * 0.5)
    let toSpawn = 0
    if (frame.beat) toSpawn += 8 + Math.round(16 * energy)
    // Sustained bass keeps a trickle of particles rising.
    const rate = this.bass > 0.4 ? (this.bass - 0.4) * 55 : 0
    this.spawnAcc += rate * this.dt
    if (this.spawnAcc > 6) this.spawnAcc = 6
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1
      toSpawn++
    }
    if (toSpawn === 0) return

    const L = this.layout
    const bars = frame.bars
    const cx = this.width * 0.5
    const s = this.height / 1080
    const particles = this.particles
    for (let k = 0; k < toSpawn; k++) {
      if (particles.isFull) break
      // Walk the bars from a moving cursor and take the next lit one so every band contributes.
      let idx = -1
      for (let step = 0; step < n; step++) {
        const i = (this.spawnCursor + step) % n
        if (bars[i] > 0.3) {
          idx = i
          this.spawnCursor = i + 1 + Math.floor(Math.random() * 3)
          break
        }
      }
      let x: number
      let y: number
      let hue: number
      if (idx >= 0) {
        const off = idx * L.slot + L.slot * 0.5
        x = mirror ? (Math.random() < 0.5 ? cx + off : cx - off) : L.inset + off
        y = L.baseY - clamp01(bars[idx]) * L.maxBarH * this.idleFade
        hue = n > 1 ? idx / (n - 1) : 0
      } else {
        x = cx + (Math.random() - 0.5) * this.width * 0.2
        y = L.baseY
        hue = this.hueT
      }
      const vx = (Math.random() - 0.5) * 90 * s
      const vy = -(50 + Math.random() * 130) * s * (0.6 + 0.9 * energy)
      const life = 0.8 + Math.random() * 1.1
      const size = (1.3 + Math.random() * 2.2) * Math.max(0.8, s)
      particles.spawn(x, y, vx, vy, life, size, hue)
    }
  }

  private compositeBars(ctx: CanvasRenderingContext2D, frame: AnalysisFrame, theme: ResolvedTheme, vs: VisualizerSettings): void {
    const w = this.width
    const h = this.height
    const z = this.zoom
    const cx = w * 0.5
    const py = this.layout.baseY

    ctx.save()
    if (z > 1.0005) {
      ctx.translate(cx, py)
      ctx.scale(z, z)
      ctx.translate(-cx, -py)
    }
    if (vs.glow && theme.glowStrength > 0) {
      const g = this.glowCtx
      g.clearRect(0, 0, this.glowW, this.glowH)
      g.filter = this.glowLowResFilter
      g.drawImage(this.barCanvas, 0, 0, this.glowW, this.glowH)
      g.filter = 'none'

      const alpha =
        theme.glowStrength *
        (0.5 + 0.3 * clamp01(frame.loudness) + 0.35 * clamp01(frame.beatIntensity)) *
        (0.35 + 0.65 * this.idleFade)
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = alpha > 1 ? 1 : alpha
      ctx.filter = GLOW_COMPOSITE_FILTER
      ctx.drawImage(this.glowCanvas, 0, 0, w, h)
      ctx.restore()
    }
    // Paint opaque bar cores last so audio-reactive bloom only lights their surroundings.
    ctx.drawImage(this.barCanvas, 0, 0, w, h)
    ctx.restore()
  }

  private drawVignette(ctx: CanvasRenderingContext2D, theme: ResolvedTheme): void {
    const bi = theme.backgroundIntensity
    if (bi <= 0 || !this.vignette) return
    ctx.globalAlpha = 0.6 * bi
    ctx.fillStyle = this.vignette
    ctx.fillRect(0, 0, this.width, this.height)
    ctx.globalAlpha = 1
  }
}

export default VisualizerRenderer
