import { describe, expect, it } from 'vitest'
import { AudioEngine } from '../../src/renderer/src/audio/AudioEngine'
import { WAVEFORM_LENGTH } from '../../src/renderer/src/audio/types'
import { DEFAULT_SETTINGS, cloneSettings, type Settings } from '../../src/shared/settings'

const SAMPLE_RATE = 48000
const FRAME_MS = 1000 / 60
const CHUNK_FRAMES = 800 // 16.67 ms at 48 kHz

interface Tone {
  hz: number
  amp: number
}

interface Harness {
  engine: AudioEngine
  settings: Settings
  now: () => number
  advance: (ms: number) => void
  /** Push `frames` of the given tones (stereo unless mono) and keep the phases continuous. */
  push: (tones: Tone[], frames?: number, channels?: number) => void
  /** Run `n` simulated 60 fps frames, pushing audio before each update. */
  run: (tones: Tone[] | null, n: number, channels?: number) => void
}

function makeHarness(mutate?: (s: Settings) => void): Harness {
  let t = 1000
  const settings = cloneSettings(DEFAULT_SETTINGS)
  mutate?.(settings)
  const engine = new AudioEngine({ audio: settings.audio, visualizer: settings.visualizer }, () => t)
  const phases = new Map<number, number>()
  const push = (tones: Tone[], frames = CHUNK_FRAMES, channels = 2): void => {
    const samples = new Float32Array(frames * channels)
    for (const tone of tones) {
      let ph = phases.get(tone.hz) ?? 0
      const step = (2 * Math.PI * tone.hz) / SAMPLE_RATE
      for (let i = 0; i < frames; i++) {
        const v = Math.sin(ph) * tone.amp
        for (let c = 0; c < channels; c++) samples[i * channels + c] += v
        ph += step
      }
      phases.set(tone.hz, ph % (2 * Math.PI))
    }
    engine.pushPcm({ sampleRate: SAMPLE_RATE, channels, frames, samples, receivedAt: t })
  }
  const advance = (ms: number): void => {
    t += ms
  }
  const run = (tones: Tone[] | null, n: number, channels = 2): void => {
    for (let i = 0; i < n; i++) {
      advance(FRAME_MS)
      if (tones) push(tones, CHUNK_FRAMES, channels)
      engine.update(t)
    }
  }
  return { engine, settings, now: () => t, advance, push, run }
}

function nearestBar(freqs: Float32Array, hz: number): number {
  let best = 0
  for (let i = 1; i < freqs.length; i++) if (Math.abs(freqs[i] - hz) < Math.abs(freqs[best] - hz)) best = i
  return best
}

const TONES: Tone[] = [
  { hz: 100, amp: 0.5 },
  { hz: 3000, amp: 0.3 }
]

describe('AudioEngine', () => {
  it('starts idle with correctly sized, zeroed arrays', () => {
    const { engine } = makeHarness()
    const f = engine.frame
    expect(f.bars.length).toBe(DEFAULT_SETTINGS.visualizer.barCount)
    expect(f.peaks.length).toBe(f.bars.length)
    expect(f.barFrequencies.length).toBe(f.bars.length)
    expect(f.spectrum.length).toBe(DEFAULT_SETTINGS.audio.fftSize / 2)
    expect(f.waveform.length).toBe(WAVEFORM_LENGTH)
    expect(f.waveformL.length).toBe(WAVEFORM_LENGTH)
    expect(f.waveformR.length).toBe(WAVEFORM_LENGTH)
    expect(f.binHz).toBeCloseTo(SAMPLE_RATE / DEFAULT_SETTINGS.audio.fftSize, 6)
    expect(f.hasSignal).toBe(false)
    expect(f.isSilent).toBe(true)
    expect(f.barFrequencies[0]).toBeGreaterThanOrEqual(20)
    expect(f.barFrequencies[f.barFrequencies.length - 1]).toBeLessThanOrEqual(20000)
    engine.update(1000)
    for (let i = 0; i < f.bars.length; i++) expect(f.bars[i]).toBe(0)
  })

  it('raises the bars near 100 Hz and 3 kHz far above the 10 kHz bar', () => {
    const h = makeHarness()
    h.run(TONES, 60) // ~1 s of audio
    const f = h.engine.frame
    expect(f.hasSignal).toBe(true)
    expect(f.isSilent).toBe(false)
    const b100 = nearestBar(f.barFrequencies, 100)
    const b3k = nearestBar(f.barFrequencies, 3000)
    const b10k = nearestBar(f.barFrequencies, 10000)
    expect(f.bars[b100]).toBeGreaterThan(0.4)
    expect(f.bars[b3k]).toBeGreaterThan(0.4)
    expect(f.bars[b10k]).toBeLessThan(0.05)
    expect(f.bars[b100] - f.bars[b10k]).toBeGreaterThan(0.3)
    expect(f.bars[b3k] - f.bars[b10k]).toBeGreaterThan(0.3)
    // Full-resolution spectrum agrees.
    const k100 = Math.round(100 / f.binHz)
    const k10k = Math.round(10000 / f.binHz)
    expect(f.spectrum[k100]).toBeGreaterThan(f.spectrum[k10k] + 0.3)
    // Levels and band energies react.
    expect(f.levelL).toBeGreaterThan(0.3)
    expect(f.levelR).toBeGreaterThan(0.3)
    expect(f.peakL).toBeGreaterThanOrEqual(f.levelL * 0.5)
    // Band energies are means over their bins, so two pure tones give small but ordered values.
    expect(f.bass).toBeGreaterThan(0.05)
    expect(f.mid).toBeGreaterThan(0.005)
    expect(f.treble).toBeLessThan(f.mid)
    expect(f.treble).toBeLessThan(f.bass)
    expect(f.loudness).toBeGreaterThan(0)
    expect(f.bassImpact).toBeGreaterThan(0)
    expect(f.sampleRate).toBe(SAMPLE_RATE)
    expect(f.channels).toBe(2)
    expect(f.sessionTime).toBeGreaterThan(0.9)
    expect(f.sessionTime).toBeLessThan(1.1)
    expect(f.clipping).toBe(false)
    for (let i = 0; i < f.bars.length; i++) {
      expect(f.bars[i]).toBeGreaterThanOrEqual(0)
      expect(f.bars[i]).toBeLessThanOrEqual(1)
      expect(Number.isFinite(f.bars[i])).toBe(true)
    }
  })

  it('keeps peaks >= bars with peak hold on, and equal with peak hold off', () => {
    const h = makeHarness()
    h.run(TONES, 40)
    h.run([{ hz: 100, amp: 0.05 }], 20) // signal drops: bars fall, peaks hold
    const f = h.engine.frame
    let held = 0
    for (let i = 0; i < f.bars.length; i++) {
      expect(f.peaks[i]).toBeGreaterThanOrEqual(f.bars[i] - 1e-6)
      if (f.peaks[i] > f.bars[i] + 0.05) held++
    }
    expect(held).toBeGreaterThan(0)

    const s2 = cloneSettings(h.settings)
    s2.audio.peakHold = false
    h.engine.applySettings({ audio: s2.audio, visualizer: s2.visualizer })
    h.run([{ hz: 100, amp: 0.05 }], 2)
    for (let i = 0; i < f.bars.length; i++) expect(f.peaks[i]).toBe(f.bars[i])
  })

  it('fills the waveforms with the latest samples (mono duplicates L/R)', () => {
    const h = makeHarness()
    h.run([{ hz: 440, amp: 0.5 }], 10)
    const f = h.engine.frame
    let energy = 0
    let max = 0
    for (let i = 0; i < WAVEFORM_LENGTH; i++) {
      energy += f.waveform[i] * f.waveform[i]
      max = Math.max(max, Math.abs(f.waveform[i]))
      expect(f.waveformL[i]).toBe(f.waveformR[i]) // identical stereo content
    }
    expect(energy).toBeGreaterThan(1)
    expect(max).toBeLessThanOrEqual(1)
    expect(max).toBeGreaterThan(0.45)

    // 1-channel input: L === R === mono
    h.run([{ hz: 440, amp: 0.5 }], 10, 1)
    expect(f.channels).toBe(1)
    for (let i = 0; i < WAVEFORM_LENGTH; i++) {
      expect(f.waveformL[i]).toBe(f.waveform[i])
      expect(f.waveformR[i]).toBe(f.waveform[i])
    }
  })

  it('hasSignal goes false after silence, bars decay linearly to zero and the waveform flattens', () => {
    const h = makeHarness()
    h.run(TONES, 60)
    const f = h.engine.frame
    expect(f.hasSignal).toBe(true)
    let sum = 0
    for (let i = 0; i < f.bars.length; i++) sum += f.bars[i]
    expect(sum).toBeGreaterThan(1)

    h.advance(300) // > 250 ms without PCM
    h.engine.update(h.now())
    expect(f.hasSignal).toBe(false)
    expect(f.isSilent).toBe(true)
    expect(f.beat).toBe(false)

    // Bars fall by `decay` per 60 fps frame and never freeze.
    const before = Float32Array.from(f.bars)
    h.run(null, 1)
    for (let i = 0; i < f.bars.length; i++) {
      if (before[i] > 0.05) {
        expect(f.bars[i]).toBeLessThan(before[i])
        expect(f.bars[i]).toBeCloseTo(Math.max(0, before[i] - DEFAULT_SETTINGS.audio.decay), 2)
      }
    }
    h.run(null, 60) // one more second of silence
    for (let i = 0; i < f.bars.length; i++) expect(f.bars[i]).toBe(0)
    for (let k = 0; k < f.spectrum.length; k++) expect(f.spectrum[k]).toBe(0)
    for (let i = 0; i < WAVEFORM_LENGTH; i++) expect(f.waveform[i]).toBe(0)
    expect(f.levelL).toBeLessThan(0.05)
    expect(f.bass).toBeLessThan(0.02)
    expect(f.bassImpact).toBe(0)

    h.run(null, 180) // > 3 s -> tempo cleared
    expect(f.bpm).toBe(0)
    expect(f.bpmConfidence).toBe(0)
    h.run(null, 120) // > 5 s -> key cleared, session ended
    expect(f.key).toBe('')
    expect(f.keyShort).toBe('')

    // Signal returns: everything comes back.
    h.run(TONES, 30)
    expect(f.hasSignal).toBe(true)
    expect(f.bars[nearestBar(f.barFrequencies, 100)]).toBeGreaterThan(0.3)
  })

  it('keeps typed-array identity across updates and only swaps on size changes', () => {
    const h = makeHarness()
    const f = h.engine.frame
    const bars = f.bars
    const peaks = f.peaks
    const spectrum = f.spectrum
    const wave = f.waveform
    const freqs = f.barFrequencies
    h.run(TONES, 20)
    expect(f.bars).toBe(bars)
    expect(f.peaks).toBe(peaks)
    expect(f.spectrum).toBe(spectrum)
    expect(f.waveform).toBe(wave)
    expect(f.barFrequencies).toBe(freqs)

    // Same sizes, different values -> same arrays, no reset of the audio buffer.
    const s1 = cloneSettings(h.settings)
    s1.audio.smoothing = 0.1
    s1.audio.sensitivity = 2
    h.engine.applySettings({ audio: s1.audio, visualizer: s1.visualizer })
    expect(f.bars).toBe(bars)
    expect(f.spectrum).toBe(spectrum)
    h.engine.update(h.now() + 1)
    expect(f.hasSignal).toBe(true) // buffer was kept

    // barCount change -> bars/peaks/barFrequencies reallocated, peaks reset.
    const s2 = cloneSettings(s1)
    s2.visualizer.barCount = 32
    h.engine.applySettings({ audio: s2.audio, visualizer: s2.visualizer })
    expect(f.bars).not.toBe(bars)
    expect(f.bars.length).toBe(32)
    expect(f.peaks.length).toBe(32)
    expect(f.barFrequencies.length).toBe(32)
    expect(f.spectrum).toBe(spectrum)
    for (let i = 0; i < 32; i++) expect(f.peaks[i]).toBe(0)

    // fftSize change -> spectrum reallocated, binHz updated.
    const s3 = cloneSettings(s2)
    s3.audio.fftSize = 2048
    h.engine.applySettings({ audio: s3.audio, visualizer: s3.visualizer })
    expect(f.spectrum).not.toBe(spectrum)
    expect(f.spectrum.length).toBe(1024)
    expect(f.binHz).toBeCloseTo(SAMPLE_RATE / 2048, 6)
    h.run(TONES, 10)
    expect(f.bars[nearestBar(f.barFrequencies, 100)]).toBeGreaterThan(0.2)
  })

  it('re-layouts when the sample rate changes and keeps running', () => {
    const h = makeHarness()
    h.run(TONES, 10)
    const f = h.engine.frame
    const freqs = f.barFrequencies
    h.engine.pushPcm({ sampleRate: 44100, channels: 2, frames: 100, samples: new Float32Array(200), receivedAt: 0 })
    h.engine.update(h.now() + 1)
    expect(f.sampleRate).toBe(44100)
    expect(f.binHz).toBeCloseTo(44100 / DEFAULT_SETTINGS.audio.fftSize, 6)
    expect(f.barFrequencies).toBe(freqs) // same length -> same array, values refreshed
    expect(f.hasSignal).toBe(true)
  })

  it('flags clipping and applies sensitivity', () => {
    const h = makeHarness()
    h.run([{ hz: 200, amp: 1.0 }], 5)
    expect(h.engine.frame.clipping).toBe(true)
    expect(h.engine.frame.peakL).toBeGreaterThan(0.95)

    const quiet = makeHarness((s) => {
      s.audio.sensitivity = 0.1
    })
    const loud = makeHarness((s) => {
      s.audio.sensitivity = 4
    })
    quiet.run([{ hz: 200, amp: 0.01 }], 30)
    loud.run([{ hz: 200, amp: 0.01 }], 30)
    const b = nearestBar(loud.engine.frame.barFrequencies, 200)
    expect(loud.engine.frame.bars[b]).toBeGreaterThan(quiet.engine.frame.bars[b])
    expect(loud.engine.frame.levelL).toBeGreaterThan(quiet.engine.frame.levelL)
  })

  it('produces beats and a plausible tempo for a 120 BPM kick pattern', () => {
    const h = makeHarness()
    const f = h.engine.frame
    let beats = 0
    let intensityPeak = 0
    const totalFrames = 60 * 12 // 12 s
    for (let i = 0; i < totalFrames; i++) {
      h.advance(FRAME_MS)
      const tMs = h.now() - 1000
      const inBeat = tMs % 500 < 90 // 90 ms kick every 500 ms
      const env = inBeat ? Math.exp(-(tMs % 500) / 40) : 0
      h.push([{ hz: 60, amp: 0.8 * env }, { hz: 2000, amp: 0.02 }])
      h.engine.update(h.now())
      if (f.beat) beats++
      intensityPeak = Math.max(intensityPeak, f.beatIntensity)
    }
    expect(beats).toBeGreaterThan(12)
    expect(beats).toBeLessThan(40)
    expect(intensityPeak).toBe(1)
    expect(f.bpm).toBeGreaterThan(110)
    expect(f.bpm).toBeLessThan(130)
    expect(f.bpmConfidence).toBeGreaterThan(0.1)
  })

  it('estimates a key from tonal content', () => {
    const h = makeHarness()
    // C major triad across octaves.
    const tones: Tone[] = []
    for (const midi of [48, 52, 55, 60, 64, 67, 72, 76, 79]) tones.push({ hz: 440 * Math.pow(2, (midi - 69) / 12), amp: 0.12 })
    h.run(tones, 60 * 3)
    expect(h.engine.frame.key).toBe('C major')
    expect(h.engine.frame.keyShort).toBe('C')
    expect(h.engine.frame.keyConfidence).toBeGreaterThan(0)
  })

  it('calls slow subscribers at their rate from inside update() and supports unsubscribe', () => {
    const h = makeHarness()
    let calls6 = 0
    let calls1 = 0
    const off6 = h.engine.subscribeSlow(() => calls6++, 6)
    const off1 = h.engine.subscribeSlow(() => calls1++, 1)
    h.run(TONES, 60) // 1 s
    expect(calls6).toBeGreaterThanOrEqual(6)
    expect(calls6).toBeLessThanOrEqual(7)
    expect(calls1).toBeGreaterThanOrEqual(1)
    expect(calls1).toBeLessThanOrEqual(2)
    off6()
    const snapshot = calls6
    h.run(TONES, 60)
    expect(calls6).toBe(snapshot)
    expect(calls1).toBeGreaterThanOrEqual(2)
    off1()

    // A throwing subscriber does not break update().
    const boom = h.engine.subscribeSlow(() => {
      throw new Error('boom')
    }, 60)
    const err = console.error
    console.error = () => {}
    try {
      expect(() => h.run(TONES, 3)).not.toThrow()
    } finally {
      console.error = err
      boom()
    }
  })

  it('reset() forgets the audio and dispose() stops processing', () => {
    const h = makeHarness()
    h.run(TONES, 30)
    const f = h.engine.frame
    expect(f.hasSignal).toBe(true)
    h.engine.reset()
    expect(f.hasSignal).toBe(false)
    expect(f.sessionTime).toBe(0)
    for (let i = 0; i < f.bars.length; i++) expect(f.bars[i]).toBe(0)
    for (let i = 0; i < WAVEFORM_LENGTH; i++) expect(f.waveform[i]).toBe(0)
    h.run(TONES, 5)
    expect(f.hasSignal).toBe(true)
    h.engine.dispose()
    h.run(TONES, 5)
    expect(f.hasSignal).toBe(false)
  })

  it('ignores malformed chunks', () => {
    const h = makeHarness()
    const f = h.engine.frame
    expect(() => {
      h.engine.pushPcm({ sampleRate: 48000, channels: 0, frames: 10, samples: new Float32Array(0), receivedAt: 0 })
      h.engine.pushPcm({ sampleRate: NaN, channels: 2, frames: 4, samples: new Float32Array([NaN, 1, 2, 3, 4, 5, 6, 7]), receivedAt: 0 })
      h.engine.pushPcm({ sampleRate: 48000, channels: 8, frames: 2, samples: new Float32Array(16), receivedAt: 0 })
      h.engine.pushPcm(null as unknown as never)
    }).not.toThrow()
    h.engine.update(h.now() + 1)
    for (let i = 0; i < WAVEFORM_LENGTH; i++) expect(Number.isFinite(f.waveform[i])).toBe(true)
    expect(f.channels).toBe(8)
    expect(f.sampleRate).toBe(SAMPLE_RATE) // NaN rate ignored
  })
})
