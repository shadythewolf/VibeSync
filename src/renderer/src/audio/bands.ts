/**
 * Log-spaced frequency bands ("bars") over a linear FFT spectrum.
 *
 * `computeBandLayout()` divides [fMin, fMax] into `barCount` geometrically spaced bands
 * and expresses each band as a fractional bin range [lo, hi) plus its centre frequency.
 * `fillBands()` reduces a normalised spectrum to one value per bar. Wide bands (treble)
 * take the maximum of their bins; bands narrower than one bin (bass at large bar counts)
 * are sampled by linear interpolation at their centre so neighbouring bars vary smoothly
 * instead of duplicating the same bin.
 */

export interface BandLayout {
  barCount: number
  fftSize: number
  sampleRate: number
  /** Hz per FFT bin. */
  binHz: number
  /** Centre frequency (Hz) of each bar (geometric mean of its edges). */
  centers: Float32Array
  /** Fractional start bin (inclusive) of each bar. */
  lo: Float32Array
  /** Fractional end bin (exclusive) of each bar. */
  hi: Float32Array
  /** Band edge frequencies in Hz, length barCount + 1. */
  edgesHz: Float32Array
}

export function computeBandLayout(
  barCount: number,
  fftSize: number,
  sampleRate: number,
  fMin = 20,
  fMax = 20000
): BandLayout {
  const bars = Math.max(1, Math.floor(barCount))
  const size = Math.max(2, Math.floor(fftSize))
  const rate = sampleRate > 0 && Number.isFinite(sampleRate) ? sampleRate : 48000
  const bins = size >> 1
  const binHz = rate / size
  const nyquist = rate / 2

  // Keep the range inside what the spectrum can represent: at least one bin above DC,
  // at most just below Nyquist, and never inverted.
  let lowest = Math.max(fMin > 0 ? fMin : 1, binHz * 0.5)
  let highest = Math.min(fMax, nyquist * 0.999)
  if (highest <= lowest * 1.01) {
    lowest = binHz
    highest = Math.max(lowest * 2, nyquist * 0.999)
  }

  const centers = new Float32Array(bars)
  const lo = new Float32Array(bars)
  const hi = new Float32Array(bars)
  const edgesHz = new Float32Array(bars + 1)
  const logLo = Math.log(lowest)
  const logRatio = Math.log(highest / lowest)
  for (let i = 0; i <= bars; i++) edgesHz[i] = Math.exp(logLo + (logRatio * i) / bars)

  const maxBin = bins // exclusive upper limit for fractional positions
  for (let i = 0; i < bars; i++) {
    const e0 = edgesHz[i]
    const e1 = edgesHz[i + 1]
    centers[i] = Math.sqrt(e0 * e1)
    let l = e0 / binHz
    let h = e1 / binHz
    // Exclude the DC bin; clamp to the spectrum.
    if (l < 1) l = 1
    if (h < l) h = l
    if (h > maxBin) h = maxBin
    if (l > maxBin - 1) l = maxBin - 1
    if (h < l) h = l
    lo[i] = l
    hi[i] = h
  }

  return { barCount: bars, fftSize: size, sampleRate: rate, binHz, centers, lo, hi, edgesHz }
}

/**
 * Reduce a normalised spectrum (0..1 per bin) to one value per bar.
 * `out.length` should equal `layout.barCount`; extra entries are left untouched.
 */
export function fillBands(spectrum: Float32Array, layout: BandLayout, out: Float32Array): void {
  const n = Math.min(out.length, layout.barCount)
  const lo = layout.lo
  const hi = layout.hi
  const lastIdx = spectrum.length - 1
  if (lastIdx < 0) {
    out.fill(0, 0, n)
    return
  }
  for (let i = 0; i < n; i++) {
    const l = lo[i]
    const h = hi[i]
    if (h - l >= 1) {
      // Wide band: peak of every bin whose index falls inside [lo, hi).
      let m = 0
      let k = Math.ceil(l)
      const end = h < lastIdx + 1 ? h : lastIdx + 1
      for (; k < end; k++) {
        const v = spectrum[k]
        if (v > m) m = v
      }
      out[i] = m
    } else {
      // Narrow band: linear interpolation at the band centre between neighbouring bins.
      const c = 0.5 * (l + h)
      let k0 = Math.floor(c)
      if (k0 < 0) k0 = 0
      if (k0 >= lastIdx) {
        out[i] = spectrum[lastIdx]
      } else {
        const frac = c - k0
        const a = spectrum[k0]
        out[i] = a + (spectrum[k0 + 1] - a) * frac
      }
    }
  }
}

/** Mean of the normalised spectrum values whose bin centres fall within [fLo, fHi] Hz. */
export function bandEnergy(spectrum: Float32Array, binHz: number, fLo: number, fHi: number): number {
  const len = spectrum.length
  if (len === 0 || !(binHz > 0)) return 0
  let k0 = Math.round(fLo / binHz)
  let k1 = Math.round(fHi / binHz)
  if (k0 < 1) k0 = 1
  if (k1 > len) k1 = len
  if (k1 <= k0) {
    if (k0 >= len) return 0
    k1 = k0 + 1
  }
  let sum = 0
  for (let k = k0; k < k1; k++) sum += spectrum[k]
  return sum / (k1 - k0)
}
