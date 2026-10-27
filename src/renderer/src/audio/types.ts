/**
 * Renderer-side audio analysis contract.
 *
 * The AudioEngine (src/renderer/src/audio/AudioEngine.ts) ingests PcmChunks and
 * produces one AnalysisFrame per animation frame. Visual mode renderers read from
 * the frame; they never touch raw PCM. React components must NOT subscribe to the
 * frame per animation frame - use `subscribeSlow` for text readouts.
 */
import type { AudioSettings, VisualizerSettings } from '@shared/settings'
import type { PcmChunk } from '@shared/types'

export interface AnalysisFrame {
  /** performance.now() of this frame (ms). */
  time: number
  /** Seconds since previous frame. */
  dt: number

  /** Smoothed, sensitivity-scaled bar heights 0..1, length === barCount. Log-spaced 20 Hz .. 20 kHz. */
  bars: Float32Array
  /** Peak-hold markers 0..1, same length as bars. Equals bars when peak hold is off. */
  peaks: Float32Array
  /** Centre frequency (Hz) of each bar. */
  barFrequencies: Float32Array

  /** Full-resolution normalised spectrum 0..1 (dB mapped between minDb..maxDb), length === fftSize / 2. */
  spectrum: Float32Array
  /** Frequency resolution of `spectrum` in Hz per bin. */
  binHz: number

  /** Latest mono samples -1..1 for oscilloscope drawing. Length WAVEFORM_LENGTH. */
  waveform: Float32Array
  /** Latest left / right samples -1..1 (mono sources duplicate). */
  waveformL: Float32Array
  waveformR: Float32Array

  /**
   * Smoothed RMS levels per channel on the meter scale: -60 dBFS .. 0 dBFS mapped to 0..1
   * (sensitivity applied). Use `levelToDbfs()` to get dBFS back; do NOT apply log10 again.
   */
  levelL: number
  levelR: number
  /** Peak-hold levels per channel on the same scale as levelL/levelR; fall slowly. */
  peakL: number
  peakR: number
  /** True if any sample exceeded +/-0.99 recently. */
  clipping: boolean

  /** Smoothed band energies 0..1 (bass 20-250 Hz, mid 250-4000 Hz, treble 4-20 kHz). */
  bass: number
  mid: number
  treble: number
  /** Overall loudness 0..1 (smoothed). */
  loudness: number
  /** Fast (unsmoothed) bass energy 0..1 - useful for kick reactive effects. */
  bassImpact: number

  /** True only on the frame where an onset/beat was detected. */
  beat: boolean
  /** 1 on a beat, decays exponentially to 0 (drive pulses and flashes with this). */
  beatIntensity: number
  /** Estimated tempo in BPM (0 when unknown). */
  bpm: number
  /** 0..1 confidence of the tempo estimate. */
  bpmConfidence: number
  /** Estimated musical key such as "A minor" or "F# major" ("" when unknown). */
  key: string
  /** Short form such as "Am" / "F#" ("" when unknown). */
  keyShort: string
  /** 0..1 confidence of the key estimate. */
  keyConfidence: number

  sampleRate: number
  channels: number
  /** True when PCM has arrived in the last 250 ms. */
  hasSignal: boolean
  /** True when the signal is effectively silent (below -70 dBFS). */
  isSilent: boolean
  /** Seconds since the first PCM chunk (session clock). */
  sessionTime: number
}

/**
 * Samples kept per waveform buffer. 2048 covers ~43 ms at 48 kHz, which is more than the
 * 32 ms slice the Pro overview summarises per column, so no audio falls between columns.
 */
export const WAVEFORM_LENGTH = 2048

/** Reference frequencies for axis labels (Hz). */
export const SPECTRUM_LABELS: readonly number[] = [20, 40, 80, 160, 320, 640, 1250, 2500, 5000, 10000, 20000]

export function formatHz(hz: number): string {
  if (hz >= 1000) {
    const k = hz / 1000
    return (k >= 10 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, '')) + 'k'
  }
  return Math.round(hz).toString()
}

export interface AudioEngineOptions {
  audio: AudioSettings
  visualizer: VisualizerSettings
}

export interface IAudioEngine {
  /** Latest analysis frame. The same object is mutated in place each update. */
  readonly frame: AnalysisFrame
  /** Feed interleaved PCM. Safe to call from IPC callbacks at any rate. */
  pushPcm(chunk: PcmChunk): void
  /** Advance analysis to `now` (ms). Called exactly once per rendered frame by the FrameScheduler. */
  update(now: number): void
  /** Apply new settings without dropping the audio buffer. */
  applySettings(opts: AudioEngineOptions): void
  /** Low-rate subscription for React text readouts (default 6 Hz). */
  subscribeSlow(cb: (frame: AnalysisFrame) => void, hz?: number): () => void
  /** Forget buffered audio (e.g. on device change). */
  reset(): void
  dispose(): void
}
