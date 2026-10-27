import type { ArtworkPalette } from '../visualizer/types'
/**
 * Current track metadata (from Spotify or the native media session) and the decoded
 * album artwork image. Position is interpolated by `getTrackPositionMs()` so the UI can
 * tick once per second without waiting for the media session to push updates.
 */
import { create } from 'zustand'
import { UNKNOWN_TRACK, type TrackInfo } from '@shared/types'
import { loadArtwork } from '../visualizer/artwork'
import { extractArtworkPalette } from '../visualizer/artworkColors'

export interface TrackState {
  track: TrackInfo
  /** Decoded artwork for the current track (null when none / still loading). */
  artwork: HTMLImageElement | null
  artworkKey: string | null
  /** One to five dominant colours extracted from the current artwork. */
  artworkPalette: ArtworkPalette | null
  _setTrack: (track: TrackInfo) => void
}

export const useTrackStore = create<TrackState>((set, get) => ({
  track: UNKNOWN_TRACK,
  artwork: null,
  artworkKey: null,
  artworkPalette: null,
  _setTrack: (track) => {
    const prev = get()
    set({ track })
    const key = track.artworkUrl ? track.artworkKey : null
    if (key === prev.artworkKey) return
    if (!key || !track.artworkUrl) {
      set({ artwork: null, artworkKey: null, artworkPalette: null })
      return
    }
    set({ artworkKey: key })
    loadArtwork(key, track.artworkUrl)
      .then((img) => {
        if (get().artworkKey === key) {
          const palette = extractArtworkPalette(img)
          set({ artwork: img, artworkPalette: palette.length > 0 ? palette : null })
        }
      })
      .catch(() => {
        if (get().artworkKey === key) set({ artwork: null, artworkPalette: null })
      })
  }
}))

/** Interpolated playback position in ms for `now` (Date.now()). */
export function getTrackPositionMs(track: TrackInfo, now: number = Date.now()): number {
  if (!track.available) return 0
  let pos = track.positionMs
  if (track.status === 'playing' && track.positionUpdatedAt > 0) {
    pos += Math.max(0, now - track.positionUpdatedAt)
  }
  if (track.durationMs > 0) pos = Math.min(pos, track.durationMs)
  return Math.max(0, pos)
}

export const getTrack = (): TrackInfo => useTrackStore.getState().track
