/**
 * Pooled particle system for the Visualizer mode.
 *
 * All state lives in preallocated typed arrays; `spawn()` / `update()` / `draw()` never
 * allocate. Dead particles are removed with swap-remove so the live set is always the
 * first `count` slots. Colours come from the theme LUT via the particle's palette
 * position (`hue`, 0..1 = the frequency position it was spawned from).
 */
import type { ResolvedTheme } from '@renderer/visualizer/types'

const TAU = Math.PI * 2
/** Particles this far outside the canvas (CSS px) are recycled. */
const OFFSCREEN_MARGIN = 24

export class ParticleSystem {
  readonly capacity: number
  /** Number of live particles (slots 0 .. count-1). */
  count = 0

  private readonly px: Float32Array
  private readonly py: Float32Array
  private readonly vx: Float32Array
  private readonly vy: Float32Array
  private readonly life: Float32Array
  private readonly maxLife: Float32Array
  private readonly size: Float32Array
  private readonly hue: Float32Array

  constructor(capacity = 240) {
    const n = Math.max(1, Math.floor(capacity))
    this.capacity = n
    this.px = new Float32Array(n)
    this.py = new Float32Array(n)
    this.vx = new Float32Array(n)
    this.vy = new Float32Array(n)
    this.life = new Float32Array(n)
    this.maxLife = new Float32Array(n)
    this.size = new Float32Array(n)
    this.hue = new Float32Array(n)
  }

  get isFull(): boolean {
    return this.count >= this.capacity
  }

  /** Adds a particle; returns false (and does nothing) when the pool is full. */
  spawn(x: number, y: number, vx: number, vy: number, life: number, size: number, hue: number): boolean {
    if (this.count >= this.capacity) return false
    if (!(life > 0)) return false
    const i = this.count++
    this.px[i] = x
    this.py[i] = y
    this.vx[i] = vx
    this.vy[i] = vy
    this.life[i] = life
    this.maxLife[i] = life
    this.size[i] = size
    this.hue[i] = hue < 0 ? 0 : hue > 1 ? 1 : hue
    return true
  }

  /**
   * Integrate one step.
   * @param dt        seconds
   * @param buoyancy  upward acceleration in px/s^2 (positive = drifts up faster over time)
   * @param drag      velocity damping per second (0 = none)
   */
  update(dt: number, width: number, height: number, buoyancy: number, drag: number): void {
    if (this.count === 0) return
    const { px, py, vx, vy, life } = this
    const damp = drag > 0 ? Math.exp(-dt * drag) : 1
    const lift = buoyancy * dt
    const minX = -OFFSCREEN_MARGIN
    const maxX = width + OFFSCREEN_MARGIN
    const minY = -OFFSCREEN_MARGIN
    const maxY = height + OFFSCREEN_MARGIN
    let i = 0
    while (i < this.count) {
      const remaining = life[i] - dt
      if (remaining <= 0) {
        this.remove(i)
        continue
      }
      life[i] = remaining
      vy[i] = (vy[i] - lift) * damp
      vx[i] *= damp
      const x = px[i] + vx[i] * dt
      const y = py[i] + vy[i] * dt
      if (x < minX || x > maxX || y < minY || y > maxY) {
        this.remove(i)
        continue
      }
      px[i] = x
      py[i] = y
      i++
    }
  }

  /** Draws every live particle as a soft dot. Leaves globalAlpha at 1 and fillStyle dirty. */
  draw(ctx: CanvasRenderingContext2D, theme: ResolvedTheme, alphaScale = 1): void {
    const n = this.count
    if (n === 0) return
    const { px, py, life, maxLife, size, hue } = this
    for (let i = 0; i < n; i++) {
      const t = life[i] / maxLife[i] // 1 at birth -> 0 at death
      // quick fade-in over the first 10 % of life, then linear fade-out
      const fadeIn = (1 - t) * 10
      const a = (fadeIn < 1 ? fadeIn : 1) * t * alphaScale
      if (a <= 0.01) continue
      ctx.globalAlpha = a > 1 ? 1 : a
      ctx.fillStyle = theme.colorAt(hue[i])
      ctx.beginPath()
      ctx.arc(px[i], py[i], size[i] * (0.55 + 0.45 * t), 0, TAU)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }

  clear(): void {
    this.count = 0
  }

  private remove(i: number): void {
    const last = --this.count
    if (i === last) return
    this.px[i] = this.px[last]
    this.py[i] = this.py[last]
    this.vx[i] = this.vx[last]
    this.vy[i] = this.vy[last]
    this.life[i] = this.life[last]
    this.maxLife[i] = this.maxLife[last]
    this.size[i] = this.size[last]
    this.hue[i] = this.hue[last]
  }
}

export default ParticleSystem
