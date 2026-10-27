/**
 * Onset (beat) detection and tempo estimation.
 *
 * `feed(value, timeMs)` is called once per analysis frame with an onset strength
 * (spectral flux + bass energy). It returns true on the frame where an onset is
 * detected: the value exceeds an adaptive threshold (mean + k * std of the last ~1.5 s)
 * and at least 120 ms have passed since the previous onset.
 *
 * Tempo: the onset-strength envelope is resampled to 100 Hz into an 8 s ring buffer.
 * Every 500 ms the (mean-removed) envelope is autocorrelated over lags corresponding to
 * 60..190 BPM, the peaks are weighted toward 90..150 BPM, octave errors are resolved by
 * inspecting the half-period lags, and the estimate is smoothed with a median of the
 * last 5 values. `confidence` is derived from the prominence of the chosen peak.
 */

const HISTORY_CAPACITY = 256
const HISTORY_WINDOW_MS = 1500
const THRESHOLD_K = 1.5
const THRESHOLD_FLOOR = 0.02
const REFRACTORY_MS = 120

const ENV_RATE_HZ = 100
const ENV_SLOT_MS = 1000 / ENV_RATE_HZ
const ENV_SECONDS = 8
const ENV_LENGTH = ENV_RATE_HZ * ENV_SECONDS
const ESTIMATE_INTERVAL_MS = 500
const MIN_ENV_SAMPLES = 2 * ENV_RATE_HZ
/** Slots a single frame may fill by holding its value (normal 60 fps pacing spans ~2). */
const ENV_HOLD_MAX_SLOTS = 4
/**
 * Onset-strength floors below which the envelope carries no rhythm. Spectral flux is
 * computed from the dB-normalised spectrum, so music sits around 5e-2 while a sustained
 * tone or silence sits near 1e-3 - roughly two orders of magnitude apart.
 */
const MIN_ENV_STD = 8e-3
const MIN_ENV_MEAN = 2e-3

const BPM_MIN = 60
const BPM_MAX = 190
const LAG_MIN = Math.floor((60 * ENV_RATE_HZ) / BPM_MAX) // 31 samples -> ~193 BPM
const LAG_MAX = Math.ceil((60 * ENV_RATE_HZ) / BPM_MIN) // 100 samples -> 60 BPM
const MEDIAN_WINDOW = 5
/** Width (octaves) of the log-Gaussian tempo prior centred on 120 BPM. */
const PRIOR_SIGMA_OCTAVES = 0.7
const PRIOR_CENTER_BPM = 120

function lagToBpm(lag: number): number {
  return (60 * ENV_RATE_HZ) / lag
}

function tempoPrior(bpm: number): number {
  const x = Math.log2(bpm / PRIOR_CENTER_BPM) / PRIOR_SIGMA_OCTAVES
  return Math.exp(-0.5 * x * x)
}

export class BeatDetector {
  /** Smoothed tempo estimate (0 when unknown). */
  bpm = 0
  /** 0..1 confidence of the tempo estimate. */
  confidence = 0
  /** Raw (unsmoothed) BPM from the most recent autocorrelation pass. */
  rawBpm = 0
  /** Number of onsets detected since the last reset. */
  onsetCount = 0

  private readonly histValue = new Float32Array(HISTORY_CAPACITY)
  private readonly histTime = new Float64Array(HISTORY_CAPACITY)
  private histHead = 0
  private histCount = 0
  private lastOnsetTime = -Infinity

  private readonly env = new Float32Array(ENV_LENGTH)
  private envSlot = -1
  private envCount = 0
  private lastEstimateTime = -Infinity

  private readonly recent = new Float32Array(MEDIAN_WINDOW)
  private recentCount = 0
  private recentHead = 0

  private readonly scratch = new Float32Array(ENV_LENGTH)
  private readonly acf = new Float32Array(LAG_MAX + 1)
  private readonly weighted = new Float32Array(LAG_MAX + 1)
  private readonly sorted = new Float32Array(MEDIAN_WINDOW)

  /** Feed one onset-strength sample. Returns true when this sample is an onset. */
  feed(value: number, timeMs: number): boolean {
    const v = Number.isFinite(value) && value > 0 ? value : 0

    // Adaptive statistics over the recent history.
    let sum = 0
    let sumSq = 0
    let n = 0
    const cutoff = timeMs - HISTORY_WINDOW_MS
    for (let i = 0; i < this.histCount; i++) {
      const idx = (this.histHead - 1 - i + HISTORY_CAPACITY) % HISTORY_CAPACITY
      if (this.histTime[idx] < cutoff) break
      const h = this.histValue[idx]
      sum += h
      sumSq += h * h
      n++
    }
    const mean = n > 0 ? sum / n : 0
    const variance = n > 1 ? Math.max(0, sumSq / n - mean * mean) : 0
    const std = Math.sqrt(variance)

    this.histValue[this.histHead] = v
    this.histTime[this.histHead] = timeMs
    this.histHead = (this.histHead + 1) % HISTORY_CAPACITY
    if (this.histCount < HISTORY_CAPACITY) this.histCount++

    // Envelope resampled to 100 Hz (max within a slot, zero-filled gaps).
    const strength = v > mean ? v - mean : 0
    const slot = Math.floor(timeMs / ENV_SLOT_MS)
    if (this.envSlot < 0 || slot - this.envSlot > ENV_LENGTH || slot < this.envSlot - ENV_LENGTH) {
      this.env.fill(0)
      this.envCount = 0
      this.envSlot = slot - 1
    }
    if (slot > this.envSlot) {
      // Analysis frames (~60 Hz) are slower than the 100 Hz envelope grid, so a frame
      // normally spans more than one slot. Hold its value across the slots it covers:
      // zero-filling them instead injects a comb at the frame rate whose autocorrelation
      // peaks at lag 50 - a phantom 120 BPM sitting exactly on the tempo prior. Only a
      // real gap (a stalled or silent source) is filled with zeros.
      const gap = slot - this.envSlot - 1
      const fill = gap <= ENV_HOLD_MAX_SLOTS ? strength : 0
      for (let s = this.envSlot + 1; s < slot; s++) {
        this.env[s % ENV_LENGTH] = fill
        if (this.envCount < ENV_LENGTH) this.envCount++
      }
      this.env[slot % ENV_LENGTH] = strength
      if (this.envCount < ENV_LENGTH) this.envCount++
      this.envSlot = slot
    } else if (slot === this.envSlot) {
      const idx = slot % ENV_LENGTH
      if (strength > this.env[idx]) this.env[idx] = strength
    }

    // Onset decision.
    let onset = false
    if (n >= 10 && v > THRESHOLD_FLOOR && v > mean + THRESHOLD_K * std && timeMs - this.lastOnsetTime >= REFRACTORY_MS) {
      onset = true
      this.lastOnsetTime = timeMs
      this.onsetCount++
    }

    // Periodic tempo estimation.
    if (timeMs - this.lastEstimateTime >= ESTIMATE_INTERVAL_MS && this.envCount >= MIN_ENV_SAMPLES) {
      this.lastEstimateTime = timeMs
      this.estimateTempo()
    }
    return onset
  }

  reset(): void {
    this.bpm = 0
    this.confidence = 0
    this.rawBpm = 0
    this.onsetCount = 0
    this.histHead = 0
    this.histCount = 0
    this.lastOnsetTime = -Infinity
    this.env.fill(0)
    this.envSlot = -1
    this.envCount = 0
    this.lastEstimateTime = -Infinity
    this.recentCount = 0
    this.recentHead = 0
  }

  /**
   * No usable tempo this round. Decay the confidence and, once it collapses, forget the
   * estimate entirely so a paused or beatless source stops reporting a stale BPM.
   */
  private loseTempo(next: number): void {
    this.confidence = next
    if (next >= 0.02) return
    this.confidence = 0
    this.bpm = 0
    this.rawBpm = 0
    this.recentCount = 0
    this.recentHead = 0
  }

  private estimateTempo(): void {
    const n = this.envCount
    const x = this.scratch
    // Unroll the ring into chronological order.
    const newest = this.envSlot % ENV_LENGTH
    let start = newest - n + 1
    while (start < 0) start += ENV_LENGTH
    let mean = 0
    for (let i = 0; i < n; i++) {
      const v = this.env[(start + i) % ENV_LENGTH]
      x[i] = v
      mean += v
    }
    mean /= n
    let energy = 0
    for (let i = 0; i < n; i++) {
      const d = x[i] - mean
      x[i] = d
      energy += d * d
    }
    const std = Math.sqrt(energy / n)
    if (std < MIN_ENV_STD || mean < MIN_ENV_MEAN) {
      // The onset envelope is at the noise floor: digital silence, a paused track, or a
      // sustained tone with no rhythm. Autocorrelating noise still produces a strong,
      // confident-looking peak (and the tempo prior parks it near 120 BPM), so a tempo
      // reported from here would be invented. Report nothing instead.
      this.loseTempo(this.confidence * 0.5)
      return
    }
    const r0 = energy / n

    const acf = this.acf
    const weighted = this.weighted
    const maxLag = Math.min(LAG_MAX, n - 1)
    acf.fill(0)
    weighted.fill(0)
    let acfMean = 0
    let acfCount = 0
    for (let lag = LAG_MIN; lag <= maxLag; lag++) {
      let s = 0
      for (let i = lag; i < n; i++) s += x[i] * x[i - lag]
      const r = s / (n - lag) / r0
      acf[lag] = r
      weighted[lag] = r * tempoPrior(lagToBpm(lag))
      acfMean += r
      acfCount++
    }
    if (acfCount < 3) return
    acfMean /= acfCount

    // Best local maximum of the weighted autocorrelation.
    let bestLag = -1
    let bestW = -Infinity
    for (let lag = LAG_MIN; lag <= maxLag; lag++) {
      const w = weighted[lag]
      const prev = lag > LAG_MIN ? weighted[lag - 1] : -Infinity
      const next = lag < maxLag ? weighted[lag + 1] : -Infinity
      if (w >= prev && w >= next && w > bestW) {
        bestW = w
        bestLag = lag
      }
    }
    // A peak sitting on the edge of the search window is not an interior maximum: the true
    // period is outside 60..190 BPM (speech, ambience, a film score) and any value we derived
    // from it would just be the boundary of our own range.
    if (bestLag < 0 || acf[bestLag] <= 0 || bestLag <= LAG_MIN || bestLag >= maxLag) {
      this.loseTempo(this.confidence * 0.5)
      return
    }

    // Octave check: if the half period and its odd multiple are both strong, the true
    // period is half of what the prior picked (we were looking at every second beat).
    let chosenLag = bestLag
    const halfLag = bestLag / 2
    if (halfLag >= LAG_MIN - 1 && lagToBpm(halfLag) <= BPM_MAX + 5) {
      const rHalf = this.interpAcf(halfLag, maxLag)
      const rThreeHalf = this.interpAcf(bestLag * 1.5, maxLag)
      const rBest = acf[bestLag]
      if (rHalf >= 0.75 * rBest && rThreeHalf >= 0.6 * rBest) {
        const cand = Math.round(halfLag)
        if (cand >= LAG_MIN && cand <= maxLag) chosenLag = cand
      }
    }

    // Parabolic interpolation around the chosen (unweighted) peak for sub-sample lag.
    let lag = chosenLag
    if (chosenLag > LAG_MIN && chosenLag < maxLag) {
      const ym = acf[chosenLag - 1]
      const y0 = acf[chosenLag]
      const yp = acf[chosenLag + 1]
      const denom = ym - 2 * y0 + yp
      if (denom < 0) {
        const delta = (0.5 * (ym - yp)) / denom
        if (delta > -1 && delta < 1) lag = chosenLag + delta
      }
    }
    const bpm = lagToBpm(lag)
    if (bpm < BPM_MIN || bpm > BPM_MAX) {
      // Clamping here would report exactly BPM_MIN/BPM_MAX, which reads like a real lock.
      this.loseTempo(this.confidence * 0.5)
      return
    }
    this.rawBpm = bpm

    // Confidence from peak prominence over the autocorrelation floor.
    const peak = acf[chosenLag]
    const prominence = Math.max(0, peak - acfMean) / Math.max(0.05, 1 - acfMean)
    const warmup = Math.min(1, n / (4 * ENV_RATE_HZ))
    const confidence = Math.min(1, prominence) * warmup
    if (confidence < 0.1) {
      this.loseTempo(this.confidence * 0.7 + confidence * 0.3)
      return
    }
    this.confidence = confidence

    // Median smoothing of the last few estimates.
    this.recent[this.recentHead] = bpm
    this.recentHead = (this.recentHead + 1) % MEDIAN_WINDOW
    if (this.recentCount < MEDIAN_WINDOW) this.recentCount++
    const m = this.recentCount
    const sorted = this.sorted
    for (let i = 0; i < m; i++) sorted[i] = this.recent[i]
    // insertion sort (m <= 5)
    for (let i = 1; i < m; i++) {
      const v = sorted[i]
      let j = i - 1
      while (j >= 0 && sorted[j] > v) {
        sorted[j + 1] = sorted[j]
        j--
      }
      sorted[j + 1] = v
    }
    this.bpm = m % 2 === 1 ? sorted[(m - 1) >> 1] : 0.5 * (sorted[m / 2 - 1] + sorted[m / 2])
  }

  private interpAcf(lag: number, maxLag: number): number {
    if (lag < LAG_MIN || lag > maxLag) return 0
    const k0 = Math.floor(lag)
    const k1 = Math.min(maxLag, k0 + 1)
    const f = lag - k0
    return this.acf[k0] + (this.acf[k1] - this.acf[k0]) * f
  }
}
