import { UNKNOWN_TRACK, type TrackInfo, type SpotifyQueueState } from '../shared/types'

const text = (value: unknown): string => typeof value === 'string' ? value.trim().slice(0, 512) : ''
const milliseconds = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), 86400000) : 0

/** A separate protocol keeps old lyrics/track packets from taking over metadata. */
export function parseBridgePlayback(packet: Record<string, unknown>): TrackInfo | null | undefined {
  if (packet.type !== 'playback') return undefined
  if (packet.available === false) return null
  if (packet.available !== true) return undefined
  const id = typeof packet.trackId === 'string' && /^[a-zA-Z0-9]{22}$/.test(packet.trackId) ? `spotify:${packet.trackId}`
    : typeof packet.uri === 'string' && /^(spotify:episode:[a-zA-Z0-9]{22}|spotify:local:[^\r\n]{1,1024})$/.test(packet.uri) ? packet.uri : ''
  if (!id) return undefined
  const title = text(packet.title)
  if (!title || !Array.isArray(packet.artists) || typeof packet.paused !== 'boolean') return undefined
  const artists = [...new Set(packet.artists.slice(0, 50).map(text).filter(Boolean))]
  const artwork = text(packet.artworkUrl)
  // Only Spotify artwork hosts are accepted; arbitrary local or remote URLs are ignored.
  const artworkUrl = /^https:\/\/(?:i\.scdn\.co|mosaic\.scdn\.co|image-cdn-ak\.spotifycdn\.com)\//.test(artwork) ? artwork : null
  const durationMs = milliseconds(packet.durationMs)
  return { ...UNKNOWN_TRACK, available: true, title, artist: artists.join(', '), album: text(packet.album),
    sourceApp: 'spotify', sourceAppName: 'Spotify', status: packet.paused ? 'paused' : 'playing',
    trackId: id, durationMs,
    positionMs: Math.min(milliseconds(packet.positionMs), durationMs || 86400000),
    positionUpdatedAt: Date.now(), artworkUrl, artworkKey: artworkUrl ? `bridge:${artworkUrl}` : null }
}

/** null means unavailable; nextTrack:null means a known empty/non-song queue. */
export function parseBridgeQueue(packet: Record<string, unknown>): SpotifyQueueState | null | undefined {
  if (packet.type !== 'queue') return undefined
  if (packet.available === false) return null
  const current = parseBridgePlayback({ ...packet, type: 'playback', title: 'Current', artists: [], paused: true })
  if (!current) return undefined
  if (packet.nextTrack === null) return { currentTrackId: current.trackId, nextTrack: null, error: null }
  if (!packet.nextTrack || typeof packet.nextTrack !== 'object' || Array.isArray(packet.nextTrack)) return undefined
  const next = parseBridgePlayback({ ...packet.nextTrack, type: 'playback', available: true, paused: true })
  if (!next) return undefined
  return { currentTrackId: current.trackId, nextTrack: {
    trackId: next.trackId, title: next.title, artist: next.artist, album: next.album, artworkUrl: next.artworkUrl
  }, error: null }
}
