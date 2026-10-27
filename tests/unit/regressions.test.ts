/**
 * Regression tests for defects found during the pre-release review.
 * Each block names the behaviour that broke so a future change cannot silently undo it.
 */
import { describe, expect, it } from 'vitest'
import { AudioEngine, levelToDbfs, LEVEL_MIN_DB } from '../../src/renderer/src/audio/AudioEngine'
import { DEFAULT_SETTINGS, cloneSettings, validateSettings, type Settings } from '../../src/shared/settings'
import { UNKNOWN_TRACK, type TrackInfo } from '../../src/shared/types'

const SAMPLE_RATE = 48000
const FRAME_MS = 1000 / 60
const CHUNK_FRAMES = 800

interface Harness {
  engine: AudioEngine
  run: (amp: number | null, frames: number) => void
  runClicks: (bpm: number, seconds: number, bedAmp?: number) => void
  /** Push one already-built stereo chunk and advance a frame. */
  pushRaw: (samples: Float32Array) => void
}

function makeHarness(mutate?: (s: Settings) => void): Harness {
  let t = 1000
  const settings = cloneSettings(DEFAULT_SETTINGS)
  mutate?.(settings)
  const engine = new AudioEngine({ audio: settings.audio, visualizer: settings.visualizer }, () => t)
  let phase = 0
  const push = (amp: number, frames: number, hz = 220): void => {
    const samples = new Float32Array(frames * 2)
    const step = (2 * Math.PI * hz) / SAMPLE_RATE
    for (let i = 0; i < frames; i++) {
      const v = Math.sin(phase) * amp
      samples[i * 2] = v
      samples[i * 2 + 1] = v
      phase += step
    }
    engine.pushPcm({ sampleRate: SAMPLE_RATE, channels: 2, frames, samples, receivedAt: t })
  }
  const run = (amp: number | null, frames: number): void => {
    for (let i = 0; i < frames; i++) {
      t += FRAME_MS
      push(amp ?? 0, CHUNK_FRAMES)
      engine.update(t)
    }
  }
  /** Percussive clicks at a fixed tempo, so the tempo estimator can lock on. */
  const runClicks = (bpm: number, seconds: number, bedAmp = 0): void => {
    const periodMs = 60000 / bpm
    let sinceClick = 0
    for (let i = 0; i < Math.round((seconds * 1000) / FRAME_MS); i++) {
      t += FRAME_MS
      const samples = new Float32Array(CHUNK_FRAMES * 2)
      sinceClick += FRAME_MS
      const click = sinceClick >= periodMs
      if (click) sinceClick -= periodMs
      for (let k = 0; k < CHUNK_FRAMES; k++) {
        // Optional sustained bed, plus a short decaying low-frequency burst = a kick.
        let v = bedAmp > 0 ? Math.sin(phase) * bedAmp : 0
        if (bedAmp > 0) phase += (2 * Math.PI * 220) / SAMPLE_RATE
        if (click && k < 900) v += Math.sin((2 * Math.PI * 70 * k) / SAMPLE_RATE) * Math.exp(-k / 260) * 0.8
        samples[k * 2] = v
        samples[k * 2 + 1] = v
      }
      engine.pushPcm({ sampleRate: SAMPLE_RATE, channels: 2, frames: CHUNK_FRAMES, samples, receivedAt: t })
      engine.update(t)
    }
  }
  const pushRaw = (samples: Float32Array): void => {
    t += FRAME_MS
    engine.pushPcm({ sampleRate: SAMPLE_RATE, channels: 2, frames: samples.length / 2, samples, receivedAt: t })
    engine.update(t)
  }
  return { engine, run, runClicks, pushRaw }
}

describe('meter levels', () => {
  it('reports levelL/peakL on one dB scale so a meter needs no second conversion', () => {
    const h = makeHarness()
    // -20 dBFS sine: amplitude 0.1, RMS 0.0707 (~ -23 dBFS).
    h.run(0.1, 120)
    const f = h.engine.frame
    const db = levelToDbfs(f.levelL)
    expect(db).toBeGreaterThan(-30)
    expect(db).toBeLessThan(-15)
    // The peak marker must never sit below the RMS bar it belongs to.
    expect(f.peakL).toBeGreaterThanOrEqual(f.levelL - 1e-6)
    expect(f.peakL).toBeLessThanOrEqual(1)
    // A -20 dBFS peak lands near the matching point on the meter, not near the top.
    expect(levelToDbfs(f.peakL)).toBeLessThan(-12)
  })

  it('levelToDbfs inverts the meter scale', () => {
    expect(levelToDbfs(1)).toBe(0)
    expect(levelToDbfs(0)).toBe(-Infinity)
    expect(levelToDbfs(0.5)).toBeCloseTo(LEVEL_MIN_DB / 2, 6)
  })
})

describe('tempo estimation', () => {
  it('locks onto the real tempo of rhythmic audio', () => {
    for (const bpm of [100, 128, 150]) {
      const h = makeHarness()
      h.runClicks(bpm, 16)
      expect(h.engine.frame.bpm, `${bpm} BPM clicks`).toBeGreaterThan(bpm - 2)
      expect(h.engine.frame.bpm, `${bpm} BPM clicks`).toBeLessThan(bpm + 2)
      expect(h.engine.frame.bpmConfidence).toBeGreaterThan(0.3)
    }
  })

  it('locks onto the beat under a sustained musical bed', () => {
    const h = makeHarness()
    h.runClicks(128, 16, 0.12)
    expect(h.engine.frame.bpm).toBeGreaterThan(126)
    expect(h.engine.frame.bpm).toBeLessThan(130)
  })

  it('reports no tempo for audio that has no beat instead of inventing one', () => {
    // A sustained tone has an onset envelope at the noise floor. Autocorrelating that noise
    // used to yield a confident 120 BPM (the centre of the tempo prior).
    const h = makeHarness()
    h.run(0.2, Math.round((16 * 1000) / FRAME_MS))
    expect(h.engine.frame.bpm).toBe(0)
    expect(h.engine.frame.bpmConfidence).toBe(0)
  })

  it('never reports the edge of its own search range as a tempo', () => {
    // Non-musical broadband noise has no periodicity: the autocorrelation peak lands on the
    // boundary of the 60..190 BPM window, which used to be clamped and shown as "190 BPM".
    const h = makeHarness()
    let seed = 7
    const noise = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff - 0.5
    }
    for (let i = 0; i < Math.round((16 * 1000) / FRAME_MS); i++) {
      const samples = new Float32Array(CHUNK_FRAMES * 2)
      for (let k = 0; k < CHUNK_FRAMES; k++) {
        const v = noise() * 0.4
        samples[k * 2] = v
        samples[k * 2 + 1] = v
      }
      h.pushRaw(samples)
    }
    const bpm = h.engine.frame.bpm
    expect(bpm === 0 || (bpm > 61 && bpm < 189), `bpm was ${bpm}`).toBe(true)
  })

  it('forgets the tempo when the source goes silent instead of freezing the last BPM', () => {
    const h = makeHarness()
    h.runClicks(120, 12)
    const locked = h.engine.frame.bpm
    expect(locked).toBeGreaterThan(0)

    // Digital silence (a paused track still streams zeros, so hasSignal stays true).
    h.run(0, Math.round((20 * 1000) / FRAME_MS))
    expect(h.engine.frame.bpm).toBe(0)
    expect(h.engine.frame.bpmConfidence).toBe(0)
  })
})

describe('settings schema', () => {
  it('defaults hardware acceleration on and coerces junk', () => {
    expect(DEFAULT_SETTINGS.general.hardwareAcceleration).toBe(true)
    expect(validateSettings({ general: { hardwareAcceleration: false } }).general.hardwareAcceleration).toBe(false)
    expect(validateSettings({ general: { hardwareAcceleration: 'nope' } }).general.hardwareAcceleration).toBe(true)
  })
})
