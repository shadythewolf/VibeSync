import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { activeLine, EMPTY_LYRICS, type LyricsState } from '@shared/lyrics'
import { frameScheduler } from '@renderer/audio'
import { getTrackPositionMs, useTrackStore } from '@renderer/store/trackStore'
import { useSettingsStore } from '@renderer/store/settingsStore'

export const useLyricsStore = create<{ state: LyricsState }>(() => ({ state: EMPTY_LYRICS }))

export function Lyrics(): JSX.Element | null {
  const state = useLyricsStore(s => s.state)
  const settings = useSettingsStore(s => s.settings.lyrics)
  const track = useTrackStore(s => s.track)
  const [index, setIndex] = useState(-1)
  const matches = state.trackId === track.trackId
  useEffect(() => {
    if (!settings.enabled || !matches || !state.lines.length) { setIndex(-1); return }
    let lastCheck = -Infinity
    const tick = (): void => {
      const t = useTrackStore.getState().track
      setIndex(activeLine(state.lines, getTrackPositionMs(t), settings.offsetMs))
    }
    tick()
    return frameScheduler.register((_frame, _dt, now) => {
      if (now - lastCheck < 100) return
      lastCheck = now
      tick()
    })
  }, [state.lines, settings.offsetMs, settings.enabled, matches, track])
  if (!settings.enabled || !matches || !state.lines.length) return null
  const line = state.lines[index]
  return (
    <div className="viz-lyrics" data-testid="lyrics" style={{ fontSize: settings.fontSize, gap: settings.lineGap, opacity: settings.opacity }} aria-label="Synchronized lyrics">
      {settings.showContext && <div className="viz-lyrics__context" data-testid="lyrics-previous">{state.lines[index - 1]?.text || '\u00a0'}</div>}
      <div className="viz-lyrics__current" data-testid="lyrics-current">{line?.text || '\u00a0'}</div>
      {settings.showContext && <div className="viz-lyrics__context" data-testid="lyrics-next">{state.lines[index + 1]?.text || '\u00a0'}</div>}
    </div>
  )
}
