/**
 * AudioEngine - interleaved PCM in, one AnalysisFrame per rendered frame out.
 *
 * Pipeline per `update(now)`:
 *   ring buffers (mono / L / R, 65536 samples each)
 *     -> latest fftSize mono samples * sensitivity -> Hann FFT -> dB
 *     -> normalised spectrum (minDb..maxDb mapped to 0..1)
 *     -> log-spaced bars (fillBands) -> frame-rate independent smoothing,
 *        linear decay and peak hold
 *     -> RMS / peak levels per channel, bass / mid / treble, loudness
 *     -> spectral flux (20-250 Hz) + bass energy -> BeatDetector (beat, bpm)
 *     -> chroma -> KeyEstimator (key)
 *
 * Typed-array identity: every Float32Array on `frame` keeps its identity across
 * updates. Identity changes ONLY when a size changes (barCount -> bars / peaks /
 * barFrequencies, fftSize -> spectrum). Renderers must therefore read `frame.bars`
 * etc. from the frame object passed to every draw call instead of caching the arrays
 * once at mount time (ModeCanvas passes the frame on each call).
 *
 * Clock: `update(now)` and the clock used internally by `pushPcm()` must share a time
 * base. The default is performance.now() (same base as requestAnimationFrame
 * timestamps); tests inject a fake clock through the constructor.
 */
import type { AudioSettings, VisualizerSettings } from '@shared/settings'
import type { PcmChunk } from '@shared/types'
import { bandEnergy, computeBandLayout, fillBands, type BandLayout } from './bands'
import { BeatDetector } from './beat'
import { FFT, magnitudeToDb } from './fft'
import { KeyEstimator } from './key'
import { WAVEFORM_LENGTH, type AnalysisFrame, type AudioEngineOptions, type IAudioEngine } from './types'

export const RING_SIZE = 65536
const RING_MASK = RING_SIZE - 1

const DEFAULT_SAMPLE_RATE = 48000
const MAX_CHANNELS = 32
const MIN_FFT_SIZE = 32
const MAX_FFT_SIZE = 32768
const MAX_BAR_COUNT = 1024

/** PCM must have arrived within this many ms for `hasSignal`. */
const SIGNAL_TIMEOUT_MS = 250
/** Without signal for this long the tempo readout is cleared. */
const BPM_TIMEOUT_MS = 3000
/** Without signal for this long the session ends (key / beat state is cleared). */
const SESSION_GAP_MS = 5000

const LEVEL_WINDOW = 2048
const LEVEL_MIN_DB = -60
const SILENCE_DB = -70
const SILENCE_RMS = Math.pow(10, SILENCE_DB / 20)
const LEVEL_ATTACK_TAU_S = 0.015
const LEVEL_RELEASE_TAU_S = 0.3
const LEVEL_PEAK_HOLD_MS = 500
const LEVEL_PEAK_FALL_PER_S = 1.0

const CLIP_THRESHOLD = 0.99
const CLIP_HOLD_MS = 400

/** Bar peak markers fall at this many full-scale units per second once the hold expires. */
const BAR_PEAK_FALL_PER_S = 1.2

/** Band energies: attack retains this fraction of the gap per 60 fps frame. */
const BAND_ATTACK_KEEP = 0.5
const BAND_RELEASE_TAU_S = 0.2
const LOUDNESS_ATTACK_TAU_S = 0.05
const LOUDNESS_RELEASE_TAU_S = 0.4

const BEAT_DECAY_PER_S = 6
/** Weight of the raw bass energy added to the spectral flux for onset detection. */
const ONSET_BASS_WEIGHT = 0.5
const FLUX_LO_HZ = 20
const FLUX_HI_HZ = 250

const KEY_ESTIMATE_INTERVAL_MS = 500

interface SlowSubscriber {
  cb: (frame: AnalysisFrame) => void
  intervalMs: number
  last: number
}

function defaultClock(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

function sanitizeFftSize(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 4096
  let p = 1 << Math.round(Math.log2(n))
  if (p < MIN_FFT_SIZE) p = MIN_FFT_SIZE
  if (p > MAX_FFT_SIZE) p = MAX_FFT_SIZE
  return p
}

function sanitizeBarCount(n: number): number {
  if (!Number.isFinite(n)) return 64
  const r = Math.round(n)
  return r < 1 ? 1 : r > MAX_BAR_COUNT ? MAX_BAR_COUNT : r
}

function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v
}

/** One-pole smoothing with separate attack / release time constants (seconds). */
function follow(current: number, target: number, dt: number, attackTau: number, releaseTau: number): number {
  const tau = target > current ? attackTau : releaseTau
  return current + (target - current) * (1 - Math.exp(-dt / tau))
}

/**
 * Map a linear amplitude (RMS or peak, 0..1) onto the meter scale: LEVEL_MIN_DB..0 dBFS
 * becomes 0..1. `frame.levelL/R` and `frame.peakL/R` are both on this scale.
 */
function rmsToLevel(rms: number): number {
  if (rms <= 0) return 0
  const db = 20 * Math.log10(rms)
  return clamp01((db - LEVEL_MIN_DB) / -LEVEL_MIN_DB)
}

/** Inverse of `rmsToLevel`: meter position 0..1 back to dBFS (-Infinity at the floor). */
export function levelToDbfs(level: number): number {
  if (!(level > 0)) return -Infinity
  const db = LEVEL_MIN_DB * (1 - clamp01(level))
  return db === 0 ? 0 : db // avoid -0 leaking into readouts
}

export { LEVEL_MIN_DB }

function createFrame(barCount: number, fftSize: number, sampleRate: number, channels: number): AnalysisFrame {
  return {
    time: 0,
    dt: 0,
    bars: new Float32Array(barCount),
    peaks: new Float32Array(barCount),
    barFrequencies: new Float32Array(barCount),
    spectrum: new Float32Array(fftSize >> 1),
    binHz: sampleRate / fftSize,
    waveform: new Float32Array(WAVEFORM_LENGTH),
    waveformL: new Float32Array(WAVEFORM_LENGTH),
    waveformR: new Float32Array(WAVEFORM_LENGTH),
    levelL: 0,
    levelR: 0,
    peakL: 0,
    peakR: 0,
    clipping: false,
    bass: 0,
    mid: 0,
    treble: 0,
    loudness: 0,
    bassImpact: 0,
    beat: false,
    beatIntensity: 0,
    bpm: 0,
    bpmConfidence: 0,
    key: '',
    keyShort: '',
    keyConfidence: 0,
    sampleRate,
    channels,
    hasSignal: false,
    isSilent: true,
    sessionTime: 0
  }
}

export class AudioEngine implements IAudioEngine {
  readonly frame: AnalysisFrame

  private audio: AudioSettings
  private visualizer: VisualizerSettings
  private readonly clock: () => number

  private sampleRate = DEFAULT_SAMPLE_RATE
  private channels = 2

  private readonly ringMono = new Float32Array(RING_SIZE)
  private readonly ringL = new Float32Array(RING_SIZE)
  private readonly ringR = new Float32Array(RING_SIZE)
  private writePos = 0
  /** Frames written since reset (saturates at RING_SIZE; only "how much is valid" matters). */
  private validFrames = 0
  /** Zeros shifted in during silence since the last PCM chunk (stops once the ring is flat). */
  private silenceZeros = 0

  private lastPcmTime = -Infinity
  private firstPcmTime = -1
  private lastClipTime = -Infinity
  private lastUpdateTime = -1
  private sessionActive = false
  private disposed = false

  private fft: FFT
  private fftInput: Float32Array
  private mags: Float32Array
  private layout: BandLayout
  private targets: Float32Array
  private peakTimes: Float64Array
  private fluxPrev = new Float32Array(0)
  private fluxStart = 1
  private fluxEnd = 1
  private spectrumZeroed = true

  private readonly beatDetector = new BeatDetector()
  private readonly keyEstimator = new KeyEstimator()
  private lastKeyEstimateTime = -Infinity
  private peakLTime = -Infinity
  private peakRTime = -Infinity

  private slow: SlowSubscriber[] = []

  constructor(opts: AudioEngineOptions, clock: () => number = defaultClock) {
    this.clock = clock
    this.audio = opts.audio
    this.visualizer = opts.visualizer
    const fftSize = sanitizeFftSize(opts.audio.fftSize)
    const barCount = sanitizeBarCount(opts.visualizer.barCount)
    this.fft = new FFT(fftSize)
    this.fftInput = new Float32Array(fftSize)
    this.mags = new Float32Array(fftSize >> 1)
    this.layout = computeBandLayout(barCount, fftSize, this.sampleRate)
    this.targets = new Float32Array(barCount)
    this.peakTimes = new Float64Array(barCount)
    this.frame = createFrame(barCount, fftSize, this.sampleRate, this.channels)
    this.frame.barFrequencies.set(this.layout.centers)
    this.frame.binHz = this.layout.binHz
    this.configureFluxRegion()
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  pushPcm(chunk: PcmChunk): void {
    if (this.disposed || !chunk) return
    const samples = chunk.samples
    if (!samples || !(samples.length > 0)) return
    const ch = Number.isInteger(chunk.channels) && chunk.channels >= 1 && chunk.channels <= MAX_CHANNELS ? chunk.channels : 1
    const maxFrames = Math.floor(samples.length / ch)
    const frames = Number.isFinite(chunk.frames) && chunk.frames > 0 ? Math.min(Math.floor(chunk.frames), maxFrames) : maxFrames
    if (frames <= 0) return

    const now = this.clock()
    const rate = chunk.sampleRate
    if (Number.isFinite(rate) && rate >= 8000 && rate <= 384000 && rate !== this.sampleRate) {
      // Device changed its mix format: re-layout the bands, keep the buffered audio.
      this.sampleRate = rate
      this.relayout(false)
    }
    if (ch !== this.channels) {
      this.channels = ch
      this.frame.channels = ch
    }
    if (!this.sessionActive || now - this.lastPcmTime > SESSION_GAP_MS) this.beginSession(now)
    this.lastPcmTime = now
    this.silenceZeros = 0

    const mono = this.ringMono
    const left = this.ringL
    const right = this.ringR
    let w = this.writePos
    let clipped = false
    if (ch === 1) {
      for (let i = 0; i < frames; i++) {
        let v = samples[i]
        if (v !== v) v = 0 // NaN guard
        if (v > CLIP_THRESHOLD || v < -CLIP_THRESHOLD) clipped = true
        mono[w] = v
        left[w] = v
        right[w] = v
        w = (w + 1) & RING_MASK
      }
    } else {
      for (let i = 0; i < frames; i++) {
        const base = i * ch
        let l = samples[base]
        let r = samples[base + 1]
        if (l !== l) l = 0
        if (r !== r) r = 0
        if (l > CLIP_THRESHOLD || l < -CLIP_THRESHOLD || r > CLIP_THRESHOLD || r < -CLIP_THRESHOLD) clipped = true
        left[w] = l
        right[w] = r
        mono[w] = (l + r) * 0.5
        w = (w + 1) & RING_MASK
      }
    }
    this.writePos = w
    this.validFrames = Math.min(RING_SIZE, this.validFrames + frames)
    if (clipped) this.lastClipTime = now
  }

  // ---------------------------------------------------------------------------
  // Analysis
  // ---------------------------------------------------------------------------

  update(now: number): void {
    if (this.disposed) return
    const frame = this.frame
    let dt = this.lastUpdateTime >= 0 ? (now - this.lastUpdateTime) / 1000 : 1 / 60
    if (!(dt >= 0)) dt = 0
    else if (dt > 0.1) dt = 0.1
    this.lastUpdateTime = now
    frame.time = now
    frame.dt = dt
    const dt60 = dt * 60

    const sinceSignal = now - this.lastPcmTime // +Infinity before the first chunk
    const hasSignal = sinceSignal < SIGNAL_TIMEOUT_MS
    frame.hasSignal = hasSignal
    frame.sampleRate = this.sampleRate
    frame.channels = this.channels
    frame.sessionTime = this.firstPcmTime >= 0 ? Math.max(0, (now - this.firstPcmTime) / 1000) : 0
    frame.clipping = now - this.lastClipTime < CLIP_HOLD_MS

    const audio = this.audio
    const sens = Number.isFinite(audio.sensitivity) && audio.sensitivity > 0 ? audio.sensitivity : 1
    const spectrum = frame.spectrum
    const targets = this.targets
    const binHz = this.layout.binHz

    let rmsL = 0
    let rmsR = 0
    let pkL = 0
    let pkR = 0
    let bassRaw = 0
    let midRaw = 0
    let trebleRaw = 0
    let loudRaw = 0
    let flux = 0

    if (hasSignal) {
      this.spectrumZeroed = false

      // --- spectrum -----------------------------------------------------------
      const n = this.fft.size
      const input = this.fftInput
      const avail = this.validFrames < n ? this.validFrames : n
      const zero = n - avail
      if (zero > 0) input.fill(0, 0, zero)
      const mono = this.ringMono
      const base = this.writePos - n
      for (let i = zero; i < n; i++) input[i] = mono[(base + i) & RING_MASK] * sens
      this.fft.magnitudes(input, this.mags, true)

      const mags = this.mags
      const minDb = audio.minDb
      const maxDb = audio.maxDb
      const invRange = maxDb > minDb ? 1 / (maxDb - minDb) : 1 / 72
      const half = n >> 1
      for (let k = 0; k < half; k++) {
        const v = (magnitudeToDb(mags[k]) - minDb) * invRange
        spectrum[k] = v <= 0 ? 0 : v >= 1 ? 1 : v
      }

      // --- spectral flux in the bass region (positive differences only) -----
      const fp = this.fluxPrev
      const fs = this.fluxStart
      const fe = this.fluxEnd
      let fsum = 0
      for (let k = fs; k < fe; k++) {
        const cur = spectrum[k]
        const d = cur - fp[k - fs]
        if (d > 0) fsum += d
        fp[k - fs] = cur
      }
      flux = fe > fs ? fsum / (fe - fs) : 0

      // --- bars & band energies ---------------------------------------------
      fillBands(spectrum, this.layout, targets)
      bassRaw = bandEnergy(spectrum, binHz, 20, 250)
      midRaw = bandEnergy(spectrum, binHz, 250, 4000)
      trebleRaw = bandEnergy(spectrum, binHz, 4000, 20000)
      let tsum = 0
      for (let i = 0; i < targets.length; i++) tsum += targets[i]
      loudRaw = targets.length > 0 ? tsum / targets.length : 0

      // --- levels (last LEVEL_WINDOW samples per channel) -------------------
      const m = this.validFrames < LEVEL_WINDOW ? this.validFrames : LEVEL_WINDOW
      if (m > 0) {
        const left = this.ringL
        const right = this.ringR
        let sumL = 0
        let sumR = 0
        const start = this.writePos - m
        for (let j = 0; j < m; j++) {
          const idx = (start + j) & RING_MASK
          const l = left[idx] * sens
          const r = right[idx] * sens
          sumL += l * l
          sumR += r * r
          const al = l < 0 ? -l : l
          const ar = r < 0 ? -r : r
          if (al > pkL) pkL = al
          if (ar > pkR) pkR = ar
        }
        rmsL = Math.sqrt(sumL / m)
        rmsR = Math.sqrt(sumR / m)
      }

      // --- key ------------------------------------------------------------------
      this.keyEstimator.accumulateChroma(spectrum, binHz, dt)
      if (now - this.lastKeyEstimateTime >= KEY_ESTIMATE_INTERVAL_MS) {
        this.lastKeyEstimateTime = now
        const k = this.keyEstimator.estimate()
        frame.key = k.key
        frame.keyShort = k.keyShort
        frame.keyConfidence = k.confidence
      }
    } else {
      if (!this.spectrumZeroed) {
        spectrum.fill(0)
        this.fluxPrev.fill(0)
        this.spectrumZeroed = true
      }
      targets.fill(0)
      // Shift zeros into the rings so the waveform slides to flat (until the ring is flat).
      if (this.validFrames > 0 && this.silenceZeros < RING_SIZE) {
        let z = Math.round(dt * this.sampleRate)
        if (z > RING_SIZE - this.silenceZeros) z = RING_SIZE - this.silenceZeros
        if (z > 0) {
          let w = this.writePos
          for (let i = 0; i < z; i++) {
            this.ringMono[w] = 0
            this.ringL[w] = 0
            this.ringR[w] = 0
            w = (w + 1) & RING_MASK
          }
          this.writePos = w
          this.silenceZeros += z
          this.validFrames = Math.min(RING_SIZE, this.validFrames + z)
        }
      }
      if (sinceSignal > BPM_TIMEOUT_MS) {
        frame.bpm = 0
        frame.bpmConfidence = 0
      }
      if (sinceSignal > SESSION_GAP_MS && this.sessionActive) this.endSession()
    }

    // --- bar smoothing, decay and peak hold -----------------------------------
    const bars = frame.bars
    const peaks = frame.peaks
    const smoothing = Number.isFinite(audio.smoothing) ? Math.min(0.99, Math.max(0, audio.smoothing)) : 0.6
    const keep = smoothing * 0.6
    const rise = 1 - Math.pow(keep, dt60)
    const decay = Number.isFinite(audio.decay) && audio.decay > 0 ? audio.decay : 0.22
    const fall = decay * dt60
    const peakHold = audio.peakHold
    const holdMs = Number.isFinite(audio.peakHoldMs) && audio.peakHoldMs >= 0 ? audio.peakHoldMs : 0
    const peakFall = BAR_PEAK_FALL_PER_S * dt
    const peakTimes = this.peakTimes
    for (let i = 0; i < bars.length; i++) {
      const t = targets[i]
      let b = bars[i]
      if (t > b) {
        b += (t - b) * rise
      } else {
        b -= fall
        if (b < t) b = t
      }
      bars[i] = b
      if (peakHold) {
        const p = peaks[i]
        if (b >= p) {
          peaks[i] = b
          peakTimes[i] = now
        } else if (now - peakTimes[i] > holdMs) {
          const np = p - peakFall
          peaks[i] = np < b ? b : np
        }
      } else {
        peaks[i] = b
      }
    }

    // --- levels ------------------------------------------------------------------
    frame.levelL = follow(frame.levelL, rmsToLevel(rmsL), dt, LEVEL_ATTACK_TAU_S, LEVEL_RELEASE_TAU_S)
    frame.levelR = follow(frame.levelR, rmsToLevel(rmsR), dt, LEVEL_ATTACK_TAU_S, LEVEL_RELEASE_TAU_S)
    // Peaks share the level scale (-60..0 dBFS mapped to 0..1) so a meter can draw the
    // peak marker directly above the RMS bar without a second conversion.
    const pl = rmsToLevel(pkL > 1 ? 1 : pkL)
    const pr = rmsToLevel(pkR > 1 ? 1 : pkR)
    if (pl >= frame.peakL) {
      frame.peakL = pl
      this.peakLTime = now
    } else if (now - this.peakLTime > LEVEL_PEAK_HOLD_MS) {
      const v = frame.peakL - LEVEL_PEAK_FALL_PER_S * dt
      frame.peakL = v < pl ? pl : v
    }
    if (pr >= frame.peakR) {
      frame.peakR = pr
      this.peakRTime = now
    } else if (now - this.peakRTime > LEVEL_PEAK_HOLD_MS) {
      const v = frame.peakR - LEVEL_PEAK_FALL_PER_S * dt
      frame.peakR = v < pr ? pr : v
    }
    frame.isSilent = !hasSignal || (rmsL < SILENCE_RMS && rmsR < SILENCE_RMS)

    // --- band energies / loudness ------------------------------------------------
    const bandRise = 1 - Math.pow(BAND_ATTACK_KEEP, dt60)
    const bandFall = 1 - Math.exp(-dt / BAND_RELEASE_TAU_S)
    frame.bass = bassRaw > frame.bass ? frame.bass + (bassRaw - frame.bass) * bandRise : frame.bass + (bassRaw - frame.bass) * bandFall
    frame.mid = midRaw > frame.mid ? frame.mid + (midRaw - frame.mid) * bandRise : frame.mid + (midRaw - frame.mid) * bandFall
    frame.treble =
      trebleRaw > frame.treble ? frame.treble + (trebleRaw - frame.treble) * bandRise : frame.treble + (trebleRaw - frame.treble) * bandFall
    frame.bassImpact = bassRaw
    frame.loudness = follow(frame.loudness, loudRaw, dt, LOUDNESS_ATTACK_TAU_S, LOUDNESS_RELEASE_TAU_S)

    // --- beat / tempo --------------------------------------------------------------
    let beat = false
    if (hasSignal) {
      beat = this.beatDetector.feed(flux + bassRaw * ONSET_BASS_WEIGHT, now)
      frame.bpm = this.beatDetector.bpm
      frame.bpmConfidence = this.beatDetector.confidence
    }
    frame.beat = beat
    const decayed = frame.beatIntensity * Math.exp(-dt * BEAT_DECAY_PER_S)
    frame.beatIntensity = beat ? 1 : decayed < 1e-4 ? 0 : decayed

    // --- waveforms -----------------------------------------------------------------
    this.copyWaveforms(sens)

    // --- slow subscribers ----------------------------------------------------------
    const subs = this.slow
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i]
      if (now - s.last >= s.intervalMs) {
        s.last = now
        try {
          s.cb(frame)
        } catch (err) {
          this.logError('subscribeSlow callback failed', err)
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  applySettings(opts: AudioEngineOptions): void {
    if (this.disposed || !opts || !opts.audio || !opts.visualizer) return
    const prevBars = sanitizeBarCount(this.visualizer.barCount)
    const prevFft = sanitizeFftSize(this.audio.fftSize)
    this.audio = opts.audio
    this.visualizer = opts.visualizer
    const nextBars = sanitizeBarCount(opts.visualizer.barCount)
    const nextFft = sanitizeFftSize(opts.audio.fftSize)
    if (nextBars !== prevBars || nextFft !== prevFft) this.relayout(true)
  }

  subscribeSlow(cb: (frame: AnalysisFrame) => void, hz = 6): () => void {
    const rate = Number.isFinite(hz) && hz > 0 ? Math.min(hz, 60) : 6
    const sub: SlowSubscriber = { cb, intervalMs: 1000 / rate, last: -Infinity }
    this.slow = [...this.slow, sub]
    return () => {
      this.slow = this.slow.filter((s) => s !== sub)
    }
  }

  reset(): void {
    this.ringMono.fill(0)
    this.ringL.fill(0)
    this.ringR.fill(0)
    this.writePos = 0
    this.validFrames = 0
    this.silenceZeros = 0
    this.lastPcmTime = -Infinity
    this.firstPcmTime = -1
    this.lastClipTime = -Infinity
    this.lastUpdateTime = -1
    this.sessionActive = false
    this.beatDetector.reset()
    this.keyEstimator.reset()
    this.lastKeyEstimateTime = -Infinity
    this.peakLTime = -Infinity
    this.peakRTime = -Infinity
    this.targets.fill(0)
    this.peakTimes.fill(0)
    this.fluxPrev.fill(0)
    this.spectrumZeroed = true
    const f = this.frame
    f.bars.fill(0)
    f.peaks.fill(0)
    f.spectrum.fill(0)
    f.waveform.fill(0)
    f.waveformL.fill(0)
    f.waveformR.fill(0)
    f.levelL = 0
    f.levelR = 0
    f.peakL = 0
    f.peakR = 0
    f.clipping = false
    f.bass = 0
    f.mid = 0
    f.treble = 0
    f.loudness = 0
    f.bassImpact = 0
    f.beat = false
    f.beatIntensity = 0
    f.bpm = 0
    f.bpmConfidence = 0
    f.key = ''
    f.keyShort = ''
    f.keyConfidence = 0
    f.hasSignal = false
    f.isSilent = true
    f.sessionTime = 0
  }

  dispose(): void {
    if (this.disposed) return
    this.reset()
    this.slow = []
    this.disposed = true
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private beginSession(now: number): void {
    this.sessionActive = true
    if (this.firstPcmTime < 0) this.firstPcmTime = now
    this.beatDetector.reset()
    this.keyEstimator.reset()
    this.lastKeyEstimateTime = -Infinity
    const f = this.frame
    f.bpm = 0
    f.bpmConfidence = 0
    f.key = ''
    f.keyShort = ''
    f.keyConfidence = 0
  }

  private endSession(): void {
    this.sessionActive = false
    this.beatDetector.reset()
    this.keyEstimator.reset()
    const f = this.frame
    f.bpm = 0
    f.bpmConfidence = 0
    f.key = ''
    f.keyShort = ''
    f.keyConfidence = 0
  }

  /** Rebuild FFT / band layout after a barCount, fftSize or sampleRate change. */
  private relayout(resetPeaks: boolean): void {
    const fftSize = sanitizeFftSize(this.audio.fftSize)
    const barCount = sanitizeBarCount(this.visualizer.barCount)
    const frame = this.frame
    if (fftSize !== this.fft.size) {
      this.fft = new FFT(fftSize)
      this.fftInput = new Float32Array(fftSize)
      this.mags = new Float32Array(fftSize >> 1)
      frame.spectrum = new Float32Array(fftSize >> 1)
      this.spectrumZeroed = true
    }
    this.layout = computeBandLayout(barCount, fftSize, this.sampleRate)
    frame.binHz = this.layout.binHz
    if (frame.bars.length !== barCount) {
      frame.bars = new Float32Array(barCount)
      frame.peaks = new Float32Array(barCount)
      frame.barFrequencies = new Float32Array(barCount)
      this.targets = new Float32Array(barCount)
      this.peakTimes = new Float64Array(barCount)
    } else if (resetPeaks) {
      frame.peaks.fill(0)
      this.peakTimes.fill(0)
    }
    frame.barFrequencies.set(this.layout.centers)
    this.configureFluxRegion()
  }

  private configureFluxRegion(): void {
    const half = this.fft.size >> 1
    const binHz = this.layout.binHz
    let start = Math.round(FLUX_LO_HZ / binHz)
    if (start < 1) start = 1
    let end = Math.round(FLUX_HI_HZ / binHz) + 1
    if (end > half) end = half
    if (end <= start) end = Math.min(half, start + 1)
    if (start >= half) {
      start = Math.max(1, half - 1)
      end = half
    }
    this.fluxStart = start
    this.fluxEnd = end
    const count = Math.max(0, end - start)
    if (this.fluxPrev.length !== count) this.fluxPrev = new Float32Array(count)
    else this.fluxPrev.fill(0)
  }

  private copyWaveforms(sens: number): void {
    const f = this.frame
    const wf = f.waveform
    const wl = f.waveformL
    const wr = f.waveformR
    const mono = this.ringMono
    const left = this.ringL
    const right = this.ringR
    const base = this.writePos - WAVEFORM_LENGTH
    for (let i = 0; i < WAVEFORM_LENGTH; i++) {
      const idx = (base + i) & RING_MASK
      let m = mono[idx] * sens
      let l = left[idx] * sens
      let r = right[idx] * sens
      if (m > 1) m = 1
      else if (m < -1) m = -1
      if (l > 1) l = 1
      else if (l < -1) l = -1
      if (r > 1) r = 1
      else if (r < -1) r = -1
      wf[i] = m
      wl[i] = l
      wr[i] = r
    }
  }

  private logError(message: string, err: unknown): void {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    try {
      // globalThis so this compiles under both the DOM (renderer) and Node (tests) configs.
      const g = globalThis as unknown as { vibedeck?: { app: { log(l: string, m: string, d?: string): void } } }
      if (g.vibedeck) {
        g.vibedeck.app.log('error', message, detail)
        return
      }
    } catch {
      /* fall through */
    }
    console.error(`[AudioEngine] ${message}`, detail)
  }
}

export default AudioEngine
