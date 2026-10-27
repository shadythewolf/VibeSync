export interface LyricLine { timeMs: number; text: string }
export interface LyricsState {
  trackId: string
  lines: LyricLine[]
  source: 'spotify' | 'lrclib' | null
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
  bridgeConnected: boolean
  bridgeVersion?: string | null
  bridgeNeedsUpdate?: boolean
  error: string | null
}
export const EMPTY_LYRICS: LyricsState = { trackId: '', lines: [], source: null, status: 'idle', bridgeConnected: false, error: null }

export function sanitizeLines(input: unknown): LyricLine[] {
  if (!Array.isArray(input) || input.length > 5000) return []
  return input.flatMap((v) => {
    if (!v || typeof v !== 'object' || typeof v.text !== 'string' || typeof v.timeMs !== 'number' || !Number.isFinite(v.timeMs) || v.timeMs < 0 || v.timeMs > 86400000) return []
    return [{ timeMs: Math.round(v.timeMs), text: v.text.slice(0, 2000) }]
  }).sort((a, b) => a.timeMs - b.timeMs)
}

export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = []
  const offset = Number(lrc.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0)
  for (const row of lrc.split(/\r?\n/)) {
    const tags = [...row.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)]
    if (!tags.length) continue
    const text = row.slice((tags.at(-1)!.index ?? 0) + tags.at(-1)![0].length).trim()
    for (const tag of tags) {
      const timeMs = Number(tag[1]) * 60000 + Number(tag[2]) * 1000 + Number((tag[3] || '').padEnd(3, '0')) + offset
      lines.push({ timeMs: Math.max(0, timeMs), text })
    }
  }
  return sanitizeLines(lines)
}

/** Last line whose timestamp has passed, including blank instrumental breaks. */
export function activeLine(lines: LyricLine[], positionMs: number, offsetMs = 0): number {
  let lo = 0, hi = lines.length
  const time = positionMs + offsetMs
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (lines[mid].timeMs <= time) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}
