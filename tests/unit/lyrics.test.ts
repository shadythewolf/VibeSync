import { describe, it, expect } from 'vitest'
import { activeLine, parseLrc, sanitizeLines } from '../../src/shared/lyrics'
import { validateSettings, mergeSettings } from '../../src/shared/settings'
import { getTrackPositionMs } from '../../src/renderer/src/store/trackStore'
import { UNKNOWN_TRACK } from '../../src/shared/types'

describe('synchronized lyrics', () => {
  it('parses multiple timestamps, decimal precision, offsets and instrumental gaps', () => {
    expect(parseLrc('[offset:-100]\n[00:01.2][00:03.456]Repeat\n[00:04.00]\n[ar:Artist]')).toEqual([
      { timeMs: 1100, text: 'Repeat' }, { timeMs: 3356, text: 'Repeat' }, { timeMs: 3900, text: '' }
    ])
  })
  it('uses exact boundaries and immediately follows seeks in either direction', () => {
    const lines = parseLrc('[00:10]One\n[00:20]Two\n[00:30]')
    expect(activeLine(lines, 9999)).toBe(-1)
    expect(activeLine(lines, 10000)).toBe(0)
    expect(activeLine(lines, 25000)).toBe(1)
    expect(activeLine(lines, 11000)).toBe(0)
    expect(activeLine(lines, 19000, 1000)).toBe(1)
    expect(activeLine(lines, 20000, -1000)).toBe(0)
    expect(activeLine(lines, 30000)).toBe(2)
  })
  it('uses the existing playback clock and freezes on pause', () => {
    const track = { ...UNKNOWN_TRACK, available: true, positionMs: 10000, positionUpdatedAt: 1000, durationMs: 50000, status: 'playing' as const }
    expect(getTrackPositionMs(track, 3000)).toBe(12000)
    expect(getTrackPositionMs({ ...track, status: 'paused' }, 3000)).toBe(10000)
    expect(getTrackPositionMs({ ...track, positionMs: 40000, positionUpdatedAt: 3000 }, 3000)).toBe(40000)
  })
  it('rejects malformed timestamps and sorts valid lines', () => {
    expect(sanitizeLines([{timeMs:NaN,text:'bad'}, {timeMs:-1,text:'bad'}, {timeMs:2,text:'two'}, {timeMs:1,text:'one'}, null])).toEqual([{timeMs:1,text:'one'}, {timeMs:2,text:'two'}])
  })
  it('migrates old settings while preserving cover colors and custom options', () => {
    const s = validateSettings({ colors: { mode:'albumArt' }, visualizer: { barCount: 80 } })
    expect(s.lyrics.enabled).toBe(true)
    const next = mergeSettings(s, { lyrics: { enabled:false, offsetMs:99999, opacity:0 } })
    expect(next.colors.mode).toBe('albumArt')
    expect(next.visualizer.barCount).toBe(80)
    expect(next.lyrics).toMatchObject({enabled:false,offsetMs:10000,opacity:.15})
  })
})
