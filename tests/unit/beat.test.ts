import { describe, expect, it } from 'vitest'
import { BeatDetector } from '../../src/renderer/src/audio/beat'

const FEED_HZ = 100
const STEP_MS = 1000 / FEED_HZ

/**
 * Feed a synthetic click envelope at `bpm` for `seconds` (100 Hz sampling, like the
 * engine at ~60 fps but on a regular grid). Each click is a sharp onset with a short
 * tail plus a little deterministic noise so the adaptive threshold has a floor.
 */
function feedClicks(det: BeatDetector, bpm: number, seconds: number, startMs = 0): { onsets: number; clicks: number } {
  const periodMs = 60000 / bpm
  let onsets = 0
  let clicks = 0
  let nextClick = startMs
  let tail = 0
  const steps = Math.round((seconds * 1000) / STEP_MS)
  for (let i = 0; i <= steps; i++) {
    const t = startMs + i * STEP_MS
    let v = 0
    if (t + STEP_MS / 2 >= nextClick) {
      v = 1
      tail = 2
      clicks++
      nextClick += periodMs
    } else if (tail > 0) {
      v = tail === 2 ? 0.55 : 0.25
      tail--
    }
    v += 0.01 * (0.5 + 0.5 * Math.sin(i * 0.37))
    if (det.feed(v, t)) onsets++
  }
  return { onsets, clicks }
}

describe('BeatDetector', () => {
  it('estimates ~120 BPM (±3) from a synthetic 120 BPM click envelope after 8 s', () => {
    const det = new BeatDetector()
    const { onsets, clicks } = feedClicks(det, 120, 8)
    expect(det.bpm).toBeGreaterThanOrEqual(117)
    expect(det.bpm).toBeLessThanOrEqual(123)
    expect(det.confidence).toBeGreaterThan(0.3)
    // Every click after the warm-up is an onset, nothing else is.
    expect(onsets).toBeGreaterThanOrEqual(clicks - 2)
    expect(onsets).toBeLessThanOrEqual(clicks)
  })

  it('tracks other tempos (100 and 140 BPM) within ±3 BPM', () => {
    for (const bpm of [100, 140]) {
      const det = new BeatDetector()
      feedClicks(det, bpm, 10)
      expect(Math.abs(det.bpm - bpm)).toBeLessThanOrEqual(3)
      expect(det.confidence).toBeGreaterThan(0.2)
    }
  })

  it('respects the 120 ms refractory period', () => {
    const det = new BeatDetector()
    // Warm up with silence-ish noise so the statistics exist.
    for (let i = 0; i < 200; i++) det.feed(0.01, i * STEP_MS)
    const t0 = 200 * STEP_MS
    expect(det.feed(1, t0)).toBe(true)
    expect(det.feed(1, t0 + 50)).toBe(false)
    expect(det.feed(1, t0 + 100)).toBe(false)
    // After the refractory window (and once the threshold has adapted) onsets are possible again.
    for (let i = 1; i <= 100; i++) det.feed(0.01, t0 + 100 + i * STEP_MS)
    expect(det.feed(1, t0 + 100 + 101 * STEP_MS)).toBe(true)
  })

  it('reports no tempo for a flat envelope and clears on reset()', () => {
    const det = new BeatDetector()
    for (let i = 0; i < 600; i++) det.feed(0.05, i * STEP_MS)
    expect(det.bpm).toBe(0)
    expect(det.confidence).toBe(0)

    feedClicks(det, 120, 8, 600 * STEP_MS)
    expect(det.bpm).toBeGreaterThan(100)
    det.reset()
    expect(det.bpm).toBe(0)
    expect(det.confidence).toBe(0)
    expect(det.onsetCount).toBe(0)
  })

  it('ignores NaN / negative input', () => {
    const det = new BeatDetector()
    expect(() => {
      for (let i = 0; i < 300; i++) det.feed(i % 2 ? NaN : -1, i * STEP_MS)
    }).not.toThrow()
    expect(det.bpm).toBe(0)
  })
})
