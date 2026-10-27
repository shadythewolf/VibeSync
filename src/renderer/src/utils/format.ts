/**
 * Formatting + small math helpers shared by the shell UI.
 */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

/** 1.25 -> '1.25×' */
export function formatMultiplier(v: number, digits = 2): string {
  return v.toFixed(digits).replace(/\.?0+$/, '') + '×'
}

/** -84 -> '-84 dB' */
export function formatDb(v: number): string {
  return `${Math.round(v)} dB`
}

/** 0.72 -> '72%' */
export function formatPercent(v: number): string {
  return `${Math.round(v * 100)}%`
}

/** 48000 -> '48 kHz' */
export function formatSampleRate(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '—'
  const k = hz / 1000
  return (Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)) + ' kHz'
}

export function formatChannels(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n === 1) return 'Mono'
  if (n === 2) return 'Stereo'
  return `${n} ch`
}

/** Compact integer formatting with thousands separators. */
export function formatInt(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return Math.round(n).toLocaleString('en-US')
}
