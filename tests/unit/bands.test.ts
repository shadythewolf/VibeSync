import { describe, expect, it } from 'vitest'
import { bandEnergy, computeBandLayout, fillBands } from '../../src/renderer/src/audio/bands'

const FFT_SIZE = 4096
const SAMPLE_RATE = 48000
const BIN_HZ = SAMPLE_RATE / FFT_SIZE

function nearestBar(centers: Float32Array, hz: number): number {
  let best = 0
  for (let i = 1; i < centers.length; i++) if (Math.abs(centers[i] - hz) < Math.abs(centers[best] - hz)) best = i
  return best
}

describe('computeBandLayout', () => {
  for (const bars of [12, 64, 160]) {
    it(`produces ${bars} monotonic centres between 20 Hz and 20 kHz`, () => {
      const layout = computeBandLayout(bars, FFT_SIZE, SAMPLE_RATE)
      expect(layout.centers.length).toBe(bars)
      expect(layout.lo.length).toBe(bars)
      expect(layout.hi.length).toBe(bars)
      expect(layout.binHz).toBeCloseTo(BIN_HZ, 6)
      for (let i = 0; i < bars; i++) {
        expect(layout.centers[i]).toBeGreaterThanOrEqual(20)
        expect(layout.centers[i]).toBeLessThanOrEqual(20000)
        expect(layout.lo[i]).toBeGreaterThanOrEqual(1) // DC bin excluded
        expect(layout.hi[i]).toBeGreaterThanOrEqual(layout.lo[i])
        expect(layout.hi[i]).toBeLessThanOrEqual(FFT_SIZE / 2)
        if (i > 0) {
          expect(layout.centers[i]).toBeGreaterThan(layout.centers[i - 1])
          expect(layout.lo[i]).toBeGreaterThanOrEqual(layout.lo[i - 1])
        }
      }
      // Log spacing: the ratio between neighbouring centres is constant.
      const r0 = layout.centers[1] / layout.centers[0]
      const r1 = layout.centers[bars - 1] / layout.centers[bars - 2]
      expect(r0).toBeCloseTo(r1, 3)
    })
  }

  it('clamps the range to what the spectrum can represent', () => {
    const layout = computeBandLayout(32, 1024, 22050) // Nyquist 11 kHz < 20 kHz
    expect(layout.centers[31]).toBeLessThan(11025)
    for (let i = 0; i < 32; i++) expect(layout.hi[i]).toBeLessThanOrEqual(512)
  })
})

describe('fillBands', () => {
  it('lights the bar nearest 60 Hz for a 60 Hz peak and leaves the 5 kHz bar at 0', () => {
    const layout = computeBandLayout(64, FFT_SIZE, SAMPLE_RATE)
    const spectrum = new Float32Array(FFT_SIZE / 2)
    // Narrow peak around 60 Hz (a few bins wide, like a windowed sine).
    for (let k = 0; k < spectrum.length; k++) {
      const f = k * BIN_HZ
      spectrum[k] = Math.exp(-((f - 60) * (f - 60)) / (2 * 12 * 12))
      if (spectrum[k] < 1e-3) spectrum[k] = 0
    }
    const out = new Float32Array(64)
    fillBands(spectrum, layout, out)

    const target = nearestBar(layout.centers, 60)
    let brightest = 0
    for (let i = 1; i < out.length; i++) if (out[i] > out[brightest]) brightest = i
    // The 60 Hz peak sits between two ~12 Hz bins, so the brightest bar is the nearest
    // one or its direct neighbour, and the nearest bar itself is clearly lit.
    expect(Math.abs(brightest - target)).toBeLessThanOrEqual(1)
    expect(out[target]).toBeGreaterThan(0.4)

    const bar5k = nearestBar(layout.centers, 5000)
    expect(out[bar5k]).toBe(0)
    // Everything above 1 kHz is dark.
    for (let i = 0; i < out.length; i++) if (layout.centers[i] > 1000) expect(out[i]).toBe(0)
  })

  it('takes the maximum inside wide (treble) bands', () => {
    const layout = computeBandLayout(32, FFT_SIZE, SAMPLE_RATE)
    const spectrum = new Float32Array(FFT_SIZE / 2)
    const bar = nearestBar(layout.centers, 10000)
    const lo = Math.ceil(layout.lo[bar])
    const hi = Math.floor(layout.hi[bar] - 1e-6)
    expect(hi - lo).toBeGreaterThan(5)
    spectrum[lo + 2] = 0.4
    spectrum[hi - 1] = 0.9
    const out = new Float32Array(32)
    fillBands(spectrum, layout, out)
    expect(out[bar]).toBeCloseTo(0.9, 6)
  })

  it('interpolates narrow bass bands so neighbouring bars differ smoothly', () => {
    const layout = computeBandLayout(160, FFT_SIZE, SAMPLE_RATE)
    const spectrum = new Float32Array(FFT_SIZE / 2)
    // A rising ramp across the bass bins: adjacent narrow bars must not duplicate values.
    for (let k = 0; k < spectrum.length; k++) spectrum[k] = Math.min(1, k / 64)
    const out = new Float32Array(160)
    fillBands(spectrum, layout, out)
    let narrowPairs = 0
    let distinct = 0
    for (let i = 1; i < 160; i++) {
      if (layout.hi[i] - layout.lo[i] < 1 && layout.hi[i - 1] - layout.lo[i - 1] < 1) {
        narrowPairs++
        if (out[i] > out[i - 1]) distinct++
      }
    }
    expect(narrowPairs).toBeGreaterThan(10)
    expect(distinct).toBe(narrowPairs)
  })

  it('handles an empty spectrum and short outputs', () => {
    const layout = computeBandLayout(8, 64, 48000)
    const out = new Float32Array(8).fill(0.5)
    fillBands(new Float32Array(0), layout, out)
    for (let i = 0; i < 8; i++) expect(out[i]).toBe(0)
    const short = new Float32Array(4)
    fillBands(new Float32Array(32).fill(1), layout, short)
    for (let i = 0; i < 4; i++) expect(short[i]).toBe(1)
  })
})

describe('bandEnergy', () => {
  it('averages the bins inside a frequency range', () => {
    const spectrum = new Float32Array(FFT_SIZE / 2)
    const k0 = Math.round(1000 / BIN_HZ)
    const k1 = Math.round(2000 / BIN_HZ)
    for (let k = k0; k < k1; k++) spectrum[k] = 0.5
    expect(bandEnergy(spectrum, BIN_HZ, 1000, 2000)).toBeCloseTo(0.5, 6)
    expect(bandEnergy(spectrum, BIN_HZ, 4000, 20000)).toBe(0)
    expect(bandEnergy(spectrum, BIN_HZ, 20, 250)).toBe(0)
  })

  it('never divides by zero or reads outside the spectrum', () => {
    const spectrum = new Float32Array(16).fill(1)
    expect(bandEnergy(spectrum, 100, 20, 40)).toBe(1) // collapses to a single bin
    expect(bandEnergy(spectrum, 100, 5000, 9000)).toBe(0) // beyond the last bin
    expect(bandEnergy(new Float32Array(0), 100, 20, 200)).toBe(0)
    expect(bandEnergy(spectrum, 0, 20, 200)).toBe(0)
  })
})
