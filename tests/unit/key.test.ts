import { describe, expect, it } from 'vitest'
import { KK_MAJOR, KK_MINOR, KeyEstimator, PITCH_CLASS_NAMES } from '../../src/renderer/src/audio/key'

const FFT_SIZE = 8192
const SAMPLE_RATE = 48000
const BIN_HZ = SAMPLE_RATE / FFT_SIZE

/** Frequency of a pitch class (0 = C) in the given octave (C4 = 261.63 Hz). */
function noteHz(pitchClass: number, octave: number): number {
  const midi = 12 * (octave + 1) + pitchClass
  return 440 * Math.pow(2, (midi - 69) / 12)
}

function spectrumFor(pitchClasses: number[], strength = 0.9): Float32Array {
  const spectrum = new Float32Array(FFT_SIZE / 2)
  for (const pc of pitchClasses) {
    for (let octave = 2; octave <= 6; octave++) {
      const bin = Math.round(noteHz(pc, octave) / BIN_HZ)
      if (bin > 0 && bin < spectrum.length) spectrum[bin] = Math.max(spectrum[bin], strength)
    }
  }
  return spectrum
}

function accumulate(est: KeyEstimator, spectrum: Float32Array, frames = 90): void {
  for (let i = 0; i < frames; i++) est.accumulateChroma(spectrum, BIN_HZ, 1 / 60)
}

describe('KeyEstimator', () => {
  it('reports C major for strong C, E and G bins', () => {
    const est = new KeyEstimator()
    accumulate(est, spectrumFor([0, 4, 7]))
    const r = est.estimate()
    expect(r.key).toBe('C major')
    expect(r.keyShort).toBe('C')
    expect(r.tonic).toBe(0)
    expect(r.mode).toBe('major')
    expect(r.confidence).toBeGreaterThan(0.1)
    expect(r.confidence).toBeLessThanOrEqual(1)
    // C, E and G dominate the chroma vector.
    const chroma = est.chroma
    for (const pc of [0, 4, 7]) expect(chroma[pc]).toBeGreaterThan(chroma[1])
  })

  it('reports A minor for A, C and E bins', () => {
    const est = new KeyEstimator()
    accumulate(est, spectrumFor([9, 0, 4]))
    const r = est.estimate()
    expect(r.key).toBe('A minor')
    expect(r.keyShort).toBe('Am')
  })

  it('names sharps correctly (F# major)', () => {
    const est = new KeyEstimator()
    accumulate(est, spectrumFor([6, 10, 1])) // F#, A#, C#
    const r = est.estimate()
    expect(r.key).toBe('F# major')
    expect(r.keyShort).toBe('F#')
  })

  it('returns unknown on silence and after reset()', () => {
    const est = new KeyEstimator()
    expect(est.estimate().key).toBe('')
    accumulate(est, spectrumFor([0, 4, 7]))
    expect(est.estimate().key).toBe('C major')
    est.reset()
    const r = est.estimate()
    expect(r.key).toBe('')
    expect(r.keyShort).toBe('')
    expect(r.confidence).toBe(0)
  })

  it('follows a key change once the old material has decayed', () => {
    const est = new KeyEstimator()
    accumulate(est, spectrumFor([0, 4, 7]), 120)
    expect(est.estimate().key).toBe('C major')
    // ~12 s of G major (G, B, D) - the exponential decay (~4 s) forgets C major.
    accumulate(est, spectrumFor([7, 11, 2]), 720)
    expect(est.estimate().key).toBe('G major')
  })

  it('exposes the Krumhansl-Kessler profiles and pitch names', () => {
    expect(KK_MAJOR.length).toBe(12)
    expect(KK_MINOR.length).toBe(12)
    expect(PITCH_CLASS_NAMES[9]).toBe('A')
    expect(KK_MAJOR[0]).toBeGreaterThan(KK_MAJOR[1])
  })
})
