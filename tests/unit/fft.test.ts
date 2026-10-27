import { describe, expect, it } from 'vitest'
import { FFT, hannWindow, isPowerOfTwo, magnitudeToDb } from '../../src/renderer/src/audio/fft'

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function naiveDft(re: Float32Array, im: Float32Array): { re: Float64Array; im: Float64Array } {
  const n = re.length
  const outRe = new Float64Array(n)
  const outIm = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    let sr = 0
    let si = 0
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * k * t) / n
      const c = Math.cos(angle)
      const s = Math.sin(angle)
      sr += re[t] * c - im[t] * s
      si += re[t] * s + im[t] * c
    }
    outRe[k] = sr
    outIm[k] = si
  }
  return { re: outRe, im: outIm }
}

describe('FFT', () => {
  for (const n of [64, 1024]) {
    it(`matches a naive DFT for N=${n} (complex random input)`, () => {
      const random = rng(1234 + n)
      const re = new Float32Array(n)
      const im = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        re[i] = random() * 2 - 1
        im[i] = random() * 2 - 1
      }
      const expected = naiveDft(re, im)
      const fft = new FFT(n)
      fft.forward(re, im)

      let maxMag = 0
      for (let k = 0; k < n; k++) maxMag = Math.max(maxMag, Math.hypot(expected.re[k], expected.im[k]))
      expect(maxMag).toBeGreaterThan(0)
      let maxErr = 0
      for (let k = 0; k < n; k++) {
        maxErr = Math.max(maxErr, Math.hypot(re[k] - expected.re[k], im[k] - expected.im[k]))
      }
      // 1e-3 relative to the spectrum peak (float32 arithmetic lands around 1e-6).
      expect(maxErr / maxMag).toBeLessThanOrEqual(1e-3)
    })
  }

  it('full-scale 1 kHz sine at 48 kHz (N=4096, Hann) peaks within 1 bin of 1 kHz with magnitude ~1.0', () => {
    const n = 4096
    const sampleRate = 48000
    const fft = new FFT(n)
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * 1000 * i) / sampleRate)
    const out = new Float32Array(n / 2)
    fft.magnitudes(input, out, true)

    let peakBin = 0
    for (let k = 1; k < out.length; k++) if (out[k] > out[peakBin]) peakBin = k
    const binHz = sampleRate / n
    expect(Math.abs(peakBin * binHz - 1000)).toBeLessThanOrEqual(binHz)
    expect(out[peakBin]).toBeGreaterThan(0.9)
    expect(out[peakBin]).toBeLessThan(1.1)
    // Far away from the tone the Hann side lobes are deep.
    const farBin = Math.round(10000 / binHz)
    expect(magnitudeToDb(out[farBin])).toBeLessThan(-80)
  })

  it('bin-centred sine without window reads exactly 1.0 and zero elsewhere', () => {
    const n = 1024
    const fft = new FFT(n)
    const bin = 37
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) input[i] = Math.cos((2 * Math.PI * bin * i) / n)
    const out = new Float32Array(n / 2)
    fft.magnitudes(input, out, false)
    expect(out[bin]).toBeCloseTo(1, 3)
    expect(out[bin + 5]).toBeLessThan(1e-4)
    expect(out[0]).toBeLessThan(1e-4)
  })

  it('bin-centred sine with the Hann window is compensated to ~1.0', () => {
    const n = 2048
    const fft = new FFT(n)
    const bin = 100
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * bin * i) / n)
    const out = new Float32Array(n / 2)
    fft.magnitudes(input, out, true)
    expect(out[bin]).toBeCloseTo(1, 2)
  })

  it('handles inputs shorter than the FFT size by zero padding', () => {
    const fft = new FFT(256)
    const out = new Float32Array(128)
    fft.magnitudes(new Float32Array(10), out, true)
    for (let k = 0; k < out.length; k++) expect(out[k]).toBe(0)
  })

  it('hannWindow is periodic with coherent gain 0.5', () => {
    const w = hannWindow(1024)
    let sum = 0
    for (let i = 0; i < w.length; i++) sum += w[i]
    expect(sum / w.length).toBeCloseTo(0.5, 6)
    expect(w[0]).toBe(0)
    expect(w[512]).toBeCloseTo(1, 6)
  })

  it('magnitudeToDb floors silence at -180 dB and maps 1.0 to 0 dB', () => {
    expect(magnitudeToDb(0)).toBeCloseTo(-180, 6)
    expect(magnitudeToDb(1)).toBeCloseTo(0, 6)
    expect(magnitudeToDb(0.5)).toBeCloseTo(-6.0206, 3)
    expect(Number.isFinite(magnitudeToDb(-1))).toBe(true)
  })

  it('rejects sizes that are not a power of two', () => {
    expect(isPowerOfTwo(4096)).toBe(true)
    expect(isPowerOfTwo(1000)).toBe(false)
    expect(() => new FFT(1000)).toThrow(RangeError)
    expect(() => new FFT(0)).toThrow(RangeError)
  })
})
