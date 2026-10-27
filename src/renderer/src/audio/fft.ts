/**
 * Real-input FFT for the analyser.
 *
 * Iterative in-place radix-2 decimation-in-time with precomputed bit-reversal and
 * twiddle tables. `magnitudes()` is the hot path used by the AudioEngine: it applies a
 * precomputed periodic Hann window, runs the transform and writes `size / 2` linear
 * magnitudes normalised so that a full-scale (amplitude 1.0) sine reads 1.0 in its bin.
 *
 * Normalisation: an amplitude-A sine produces |X[k]| = A * N / 2 in an unwindowed FFT,
 * and the periodic Hann window has a coherent gain of exactly 0.5, so the windowed
 * value is A * N / 4. We therefore scale by 2 / N (no window) or 4 / N (Hann).
 */

const MAX_FFT_SIZE = 1 << 20

export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0
}

/** Periodic Hann window (coherent gain 0.5) of the given length. */
export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size)
  if (size <= 0) return w
  if (size === 1) {
    w[0] = 1
    return w
  }
  const step = (2 * Math.PI) / size
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos(step * i)
  return w
}

/** Linear magnitude -> dB, floored at -180 dB so silence never becomes -Infinity/NaN. */
export function magnitudeToDb(m: number): number {
  return 20 * Math.log10(m > 1e-9 ? m : 1e-9)
}

export class FFT {
  readonly size: number
  private readonly bits: number
  private readonly rev: Uint32Array
  private readonly cosTable: Float32Array
  private readonly sinTable: Float32Array
  private readonly window: Float32Array
  private readonly re: Float32Array
  private readonly im: Float32Array

  constructor(size: number) {
    if (!isPowerOfTwo(size) || size < 2 || size > MAX_FFT_SIZE) {
      throw new RangeError(`FFT size must be a power of two between 2 and ${MAX_FFT_SIZE}, got ${size}`)
    }
    this.size = size
    this.bits = Math.log2(size) | 0

    // Bit-reversal permutation table.
    const rev = new Uint32Array(size)
    for (let i = 0; i < size; i++) {
      let x = i
      let r = 0
      for (let b = 0; b < this.bits; b++) {
        r = (r << 1) | (x & 1)
        x >>>= 1
      }
      rev[i] = r >>> 0
    }
    this.rev = rev

    // Twiddles exp(-2*pi*i*k/N) for k in [0, N/2).
    const half = size >> 1
    const cosTable = new Float32Array(half)
    const sinTable = new Float32Array(half)
    const step = (-2 * Math.PI) / size
    for (let k = 0; k < half; k++) {
      cosTable[k] = Math.cos(step * k)
      sinTable[k] = Math.sin(step * k)
    }
    this.cosTable = cosTable
    this.sinTable = sinTable

    this.window = hannWindow(size)
    this.re = new Float32Array(size)
    this.im = new Float32Array(size)
  }

  /**
   * In-place forward complex FFT. Both arrays must have length >= size; only the first
   * `size` entries are transformed.
   */
  forward(re: Float32Array, im: Float32Array): void {
    const n = this.size
    if (re.length < n || im.length < n) {
      throw new RangeError(`FFT.forward expects arrays of length >= ${n}`)
    }
    const rev = this.rev
    // Bit-reverse reorder.
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        const tr = re[i]
        re[i] = re[j]
        re[j] = tr
        const ti = im[i]
        im[i] = im[j]
        im[j] = ti
      }
    }
    const cosT = this.cosTable
    const sinT = this.sinTable
    for (let span = 2; span <= n; span <<= 1) {
      const half = span >> 1
      const tableStep = n / span
      for (let start = 0; start < n; start += span) {
        let k = 0
        for (let j = start; j < start + half; j++) {
          const wr = cosT[k]
          const wi = sinT[k]
          const b = j + half
          const br = re[b]
          const bi = im[b]
          const tr = br * wr - bi * wi
          const ti = br * wi + bi * wr
          const ar = re[j]
          const ai = im[j]
          re[b] = ar - tr
          im[b] = ai - ti
          re[j] = ar + tr
          im[j] = ai + ti
          k += tableStep
        }
      }
    }
  }

  /**
   * Windowed magnitude spectrum of a real signal. Writes `size / 2` values into `out`
   * (bins 0 .. Nyquist-1) normalised so a full-scale sine reads ~1.0.
   * If `input` is shorter than `size` the remainder is treated as zeros.
   */
  magnitudes(input: Float32Array, out: Float32Array, window = true): void {
    const n = this.size
    const half = n >> 1
    if (out.length < half) {
      throw new RangeError(`FFT.magnitudes expects an output of length >= ${half}`)
    }
    const re = this.re
    const im = this.im
    const avail = input.length < n ? input.length : n
    if (window) {
      const w = this.window
      for (let i = 0; i < avail; i++) re[i] = input[i] * w[i]
    } else {
      for (let i = 0; i < avail; i++) re[i] = input[i]
    }
    if (avail < n) re.fill(0, avail)
    im.fill(0)
    this.forward(re, im)
    const scale = window ? 4 / n : 2 / n
    for (let k = 0; k < half; k++) {
      const r = re[k]
      const i = im[k]
      out[k] = Math.sqrt(r * r + i * i) * scale
    }
  }
}
