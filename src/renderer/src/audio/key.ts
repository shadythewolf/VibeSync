/**
 * Musical key estimation from the normalised spectrum.
 *
 * Spectral peaks (local maxima of the normalised spectrum) between 55 Hz and 2.2 kHz
 * are folded onto 12 pitch classes into an exponentially decaying chroma vector
 * (~4 s time constant, so roughly the last 6 s dominate). Each peak contributes its
 * normalised value to the 4th power (the spectrum is dB-mapped, so this restores some
 * dynamic range and suppresses the noise floor) times a resolution weight that fades
 * out bins whose width exceeds a semitone (bass region of small FFTs). Mapping the
 * *peak* bin to its nearest pitch class keeps the result independent of how a note
 * happens to align with the FFT grid.
 *
 * `estimate()` correlates the chroma with the 24 Krumhansl-Kessler key profiles and
 * reports the best match plus a confidence derived from the gap between the best and
 * second best correlation.
 */

const F_LO = 55
const F_HI = 2200
const A4 = 440
const DECAY_TAU_S = 4
const MIN_CHROMA_ENERGY = 1e-4
/** A correlation gap of this size between the two best keys counts as fully confident. */
const FULL_CONFIDENCE_GAP = 0.2
/** Normalised values below this never count as a spectral peak. */
const MIN_PEAK_VALUE = 0.05
/** Width of one semitone as a fraction of the frequency (2^(1/12) - 1). */
const SEMITONE_RATIO = Math.pow(2, 1 / 12) - 1

export const PITCH_CLASS_NAMES: readonly string[] = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** Krumhansl-Kessler tonal hierarchy profiles (relative to the tonic). */
export const KK_MAJOR: readonly number[] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
export const KK_MINOR: readonly number[] = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

export interface KeyEstimate {
  /** Long name such as "A minor" ("" when unknown). */
  key: string
  /** Short name such as "Am" / "F#" ("" when unknown). */
  keyShort: string
  /** 0..1 */
  confidence: number
  /** Pitch class of the tonic (0 = C), -1 when unknown. */
  tonic: number
  mode: 'major' | 'minor' | ''
}

export const UNKNOWN_KEY: Readonly<KeyEstimate> = Object.freeze({ key: '', keyShort: '', confidence: 0, tonic: -1, mode: '' })

function centre(values: readonly number[]): { c: Float64Array; norm: number } {
  const n = values.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += values[i]
  mean /= n
  const c = new Float64Array(n)
  let ss = 0
  for (let i = 0; i < n; i++) {
    c[i] = values[i] - mean
    ss += c[i] * c[i]
  }
  return { c, norm: Math.sqrt(ss) }
}

const MAJOR = centre(KK_MAJOR)
const MINOR = centre(KK_MINOR)

export class KeyEstimator {
  /** Decayed chroma energy per pitch class (0 = C). */
  readonly chroma = new Float32Array(12)

  private binPitchClass: Int8Array = new Int8Array(0)
  private binWeight: Float32Array = new Float32Array(0)
  private binStart = 0
  private binEnd = 0
  private mappedBinHz = 0
  private mappedLength = 0
  private last: KeyEstimate = { ...UNKNOWN_KEY }
  private readonly centred = new Float64Array(12)

  /** Most recent result of `estimate()`. */
  get result(): KeyEstimate {
    return this.last
  }

  /**
   * Fold the spectral peaks of the normalised spectrum (0..1 per bin) onto the chroma
   * vector. `dtSeconds` controls the exponential decay (default one 60 fps frame).
   */
  accumulateChroma(spectrumNormalised: Float32Array, binHz: number, dtSeconds = 1 / 60): void {
    if (!(binHz > 0) || spectrumNormalised.length === 0) return
    if (binHz !== this.mappedBinHz || spectrumNormalised.length !== this.mappedLength) {
      this.buildMap(binHz, spectrumNormalised.length)
    }
    const dt = dtSeconds > 0 && Number.isFinite(dtSeconds) ? Math.min(dtSeconds, 0.5) : 1 / 60
    const decay = Math.exp(-dt / DECAY_TAU_S)
    const chroma = this.chroma
    for (let i = 0; i < 12; i++) chroma[i] *= decay
    const gain = dt * 60
    const pcs = this.binPitchClass
    const ws = this.binWeight
    const s = spectrumNormalised
    const last = s.length - 1
    const start = this.binStart
    for (let k = start; k < this.binEnd; k++) {
      const v = s[k]
      if (v < MIN_PEAK_VALUE) continue
      // Local maximum only (strict on the left so a plateau of two equal bins counts once).
      if (k > 0 && !(v > s[k - 1])) continue
      if (k < last && !(v >= s[k + 1])) continue
      const idx = k - start
      const v2 = v * v
      chroma[pcs[idx]] += v2 * v2 * ws[idx] * gain
    }
  }

  /** Correlate the chroma against the 24 key profiles. */
  estimate(): KeyEstimate {
    const chroma = this.chroma
    let total = 0
    for (let i = 0; i < 12; i++) total += chroma[i]
    if (!(total > MIN_CHROMA_ENERGY)) {
      this.last = { ...UNKNOWN_KEY }
      return this.last
    }
    const mean = total / 12
    const c = this.centred
    let ss = 0
    for (let i = 0; i < 12; i++) {
      c[i] = chroma[i] - mean
      ss += c[i] * c[i]
    }
    const norm = Math.sqrt(ss)
    if (norm <= 1e-9) {
      this.last = { ...UNKNOWN_KEY }
      return this.last
    }

    let best = -Infinity
    let second = -Infinity
    let bestTonic = -1
    let bestMode: 'major' | 'minor' = 'major'
    for (let tonic = 0; tonic < 12; tonic++) {
      const rMaj = this.correlate(c, norm, MAJOR.c, MAJOR.norm, tonic)
      const rMin = this.correlate(c, norm, MINOR.c, MINOR.norm, tonic)
      if (rMaj > best) {
        second = best
        best = rMaj
        bestTonic = tonic
        bestMode = 'major'
      } else if (rMaj > second) second = rMaj
      if (rMin > best) {
        second = best
        best = rMin
        bestTonic = tonic
        bestMode = 'minor'
      } else if (rMin > second) second = rMin
    }
    if (bestTonic < 0 || !(best > 0)) {
      this.last = { ...UNKNOWN_KEY }
      return this.last
    }
    const gap = best - (Number.isFinite(second) ? second : 0)
    const confidence = Math.max(0, Math.min(1, gap / FULL_CONFIDENCE_GAP)) * Math.max(0, Math.min(1, best))
    const name = PITCH_CLASS_NAMES[bestTonic]
    this.last = {
      key: `${name} ${bestMode}`,
      keyShort: bestMode === 'minor' ? `${name}m` : name,
      confidence,
      tonic: bestTonic,
      mode: bestMode
    }
    return this.last
  }

  reset(): void {
    this.chroma.fill(0)
    this.last = { ...UNKNOWN_KEY }
  }

  private correlate(c: Float64Array, norm: number, profile: Float64Array, profileNorm: number, tonic: number): number {
    let dot = 0
    for (let i = 0; i < 12; i++) {
      // profile index i is the interval above the tonic; pitch class = (tonic + i) mod 12
      dot += c[(tonic + i) % 12] * profile[i]
    }
    return dot / (norm * profileNorm)
  }

  private buildMap(binHz: number, length: number): void {
    this.mappedBinHz = binHz
    this.mappedLength = length
    let start = Math.ceil(F_LO / binHz)
    let end = Math.floor(F_HI / binHz) + 1
    if (start < 1) start = 1
    if (end > length) end = length
    if (end <= start) {
      start = 0
      end = 0
    }
    this.binStart = start
    this.binEnd = end
    const count = end - start
    if (this.binPitchClass.length !== count) {
      this.binPitchClass = new Int8Array(count)
      this.binWeight = new Float32Array(count)
    }
    for (let k = start; k < end; k++) {
      const f = k * binHz
      const semis = 12 * Math.log2(f / A4) // 0 = A4
      const nearest = Math.round(semis)
      const pc = (((nearest + 9) % 12) + 12) % 12 // A4 -> pitch class 9
      this.binPitchClass[k - start] = pc
      // Resolution weight: a bin that spans more than one semitone cannot tell notes
      // apart, so it counts in proportion to how many bins one semitone covers there.
      const semitoneBins = (f * SEMITONE_RATIO) / binHz
      this.binWeight[k - start] = semitoneBins >= 1 ? 1 : semitoneBins
    }
  }
}
