import { app, BrowserWindow } from 'electron'
import type { IncomingMessage } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { IPC } from '../shared/ipc'
import { EMPTY_LYRICS, sanitizeLines, parseLrc, type LyricsState, type LyricLine } from '../shared/lyrics'
import { EMPTY_SPOTIFY_QUEUE, type SpotifyQueueState, type TrackInfo } from '../shared/types'
import type { MetadataService } from './metadataService'
import { settingsStore } from './settingsStore'
import { log } from './logger'
import { parseBridgePlayback, parseBridgeQueue } from './bridgePlayback'

// Only isolated QA profiles may opt into an ephemeral port; normal launches stay fixed.
const PORT = process.env.VIBEDECK_USER_DATA && process.env.VIBESYNC_BRIDGE_TEST_PORT === '0' ? 0 : 43821
const HEARTBEAT_INTERVAL_MS = 15000
const HEARTBEAT_TIMEOUT_MS = 45000
const TTL = 30 * 86400000
const keyOf = (t: TrackInfo): string => createHash('sha256').update(JSON.stringify([t.title, t.artist, t.album, Math.round(t.durationMs / 1000)])).digest('hex')
interface CacheEntry { at: number; source: 'spotify' | 'lrclib'; lines: LyricLine[] }

export class LyricsService {
  private state: LyricsState = { ...EMPTY_LYRICS }
  private server: WebSocketServer | null = null
  private socket: WebSocket | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private lastPlaybackAt = 0
  private expectsPlayback = false
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null
  private bridgePlayback: TrackInfo | null = null
  private bridgeQueue: SpotifyQueueState | null = null
  private queueState: SpotifyQueueState = { ...EMPTY_SPOTIFY_QUEUE }
  private queueArtworkUrl: string | null = null
  private queueExpiry: ReturnType<typeof setTimeout> | null = null
  private bridgeArtwork = new Map<string, string>()
  private artworkRequests = new Map<string, Promise<void>>()
  private artworkRetryAt = new Map<string, number>()
  private playbackExpiry: ReturnType<typeof setTimeout> | null = null
  private lastPong = 0
  private generation = 0
  private currentKey = ''
  private bridgeLyrics = new Map<string, { status: string; lines: LyricLine[] }>()
  private cache = new Map<string, CacheEntry>()
  private abort: AbortController | null = null
  private unsubscribe: (() => void) | null = null
  private unsubscribeSettings: (() => void) | null = null
  private cacheDir = join(app.getPath('userData'), 'lyrics')

  constructor(private readonly metadata: MetadataService) {}
  getState(): LyricsState { return this.state }
  getQueue(): SpotifyQueueState { return this.queueState }

  private publishQueue(): void {
    this.queueState = settingsStore.get().spotify.showNextTrack && this.bridgeQueue ? this.bridgeQueue : { ...EMPTY_SPOTIFY_QUEUE }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.spotifyQueueChanged, this.queueState)
    }
  }

  private clearBridgeQueue(): void {
    if (this.queueExpiry) clearTimeout(this.queueExpiry)
    this.queueExpiry = null
    this.bridgeQueue = null
    this.queueArtworkUrl = null
    this.publishQueue()
  }

  start(): void {
    this.unsubscribe = this.metadata.subscribe((track) => this.onTrack(track))
    this.unsubscribeSettings = settingsStore.subscribe((next, prev) => {
      if (next.spotify.showNextTrack !== prev.spotify.showNextTrack) {
        this.publishQueue()
        if (next.spotify.showNextTrack && this.queueArtworkUrl) void this.loadBridgeArtwork(this.queueArtworkUrl)
      }
      if (next.lyrics.enabled === prev.lyrics.enabled) return
      this.send({ type: 'config', enabled: next.lyrics.enabled, requestSnapshots: true })
      this.bridgeLyrics.clear()
      this.currentKey = ''
      this.onTrack(this.metadata.getTrack())
    })
    this.server = new WebSocketServer({ host: '127.0.0.1', port: PORT, maxPayload: 1024 * 1024,
      verifyClient: ({ origin, req }: { origin: string; req: IncomingMessage }) => {
        const local = req.socket.remoteAddress === '127.0.0.1'
        const bridgePath = req.url === '/vibesync' || req.url === '/vibedeck'
        return local && bridgePath && (!origin || origin === 'https://xpui.app.spotify.com' || origin === 'https://open.spotify.com')
      }
    })
    this.server.on('error', (err) => {
      log('warn', 'Spotify bridge server error', err)
      this.publish({ error: `Spotify bridge cannot listen on 127.0.0.1:${PORT}. Close another app using this port and restart VibeSync.` })
    })
    this.server.on('connection', (socket) => {
      if (this.socket) { socket.close(1008, 'One Spotify client at a time'); return }
      this.socket = socket
      this.lastPong = Date.now()
      this.lastPlaybackAt = Date.now()
      this.expectsPlayback = false
      log('info', 'Spotify bridge connected')
      this.publish({ bridgeConnected: true, bridgeVersion: null, bridgeNeedsUpdate: true, error: null })
      this.send({ type: 'config', enabled: settingsStore.get().lyrics.enabled, requestSnapshots: true })
      socket.on('pong', () => {
        if (this.socket === socket) this.lastPong = Date.now()
      })
      socket.on('error', (err) => {
        log('warn', 'Spotify bridge socket error', err)
        socket.terminate()
      })
      socket.on('message', (data) => {
        if (this.socket !== socket) return
        try { this.receive(JSON.parse(data.toString())) } catch { /* discard malformed packets */ }
      })
      socket.on('close', (code) => {
        if (this.socket !== socket) return
        log('info', `Spotify bridge disconnected (code ${code ?? 'unknown'})`)
        this.socket = null
        this.clearBridgePlayback()
        this.publish({ bridgeConnected: false, bridgeVersion: null, bridgeNeedsUpdate: false })
      })
    })
    this.timer = setInterval(() => {
      const socket = this.socket
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      // Browser WebSockets answer protocol pings independently of Spotify's JS timers.
      // Missing track/position updates alone do not mean the connection is broken.
      if (Date.now() - this.lastPong >= HEARTBEAT_TIMEOUT_MS) {
        log('warn', 'Spotify bridge heartbeat timed out')
        socket.terminate()
        return
      }
      try { socket.ping() } catch { socket.terminate() }
    }, HEARTBEAT_INTERVAL_MS)
    // Incoming WebSocket messages keep snapshot delivery independent of Spotify's
    // potentially throttled page timers. This never polls Spotify's Web API.
    this.refreshTimer = setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return
      if (this.expectsPlayback && Date.now() - this.lastPlaybackAt >= 15000) {
        log('warn', `Spotify bridge supplied no playback snapshots for ${Math.round((Date.now() - this.lastPlaybackAt) / 1000)}s; reconnecting`)
        this.socket.terminate()
        return
      }
      this.send({ type: 'refresh' })
    }, 1000)
    void this.pruneCache()
    this.onTrack(this.metadata.getTrack())
  }

  stop(): void {
    this.unsubscribe?.(); this.unsubscribeSettings?.()
    if (this.timer) clearInterval(this.timer)
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer)
    this.abort?.abort()
    this.clearBridgePlayback()
    this.socket?.terminate(); this.server?.close()
  }

  private send(packet: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(packet))
  }
  private publish(patch: Partial<LyricsState>): void {
    this.state = { ...this.state, ...patch }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.lyricsChanged, this.state)
    }
  }

  private clearBridgePlayback(): void {
    if (this.playbackExpiry) clearTimeout(this.playbackExpiry)
    this.playbackExpiry = null
    this.bridgePlayback = null
    this.clearBridgeQueue()
    this.metadata.setBridgeTrack(null)
  }

  private async loadBridgeArtwork(url: string): Promise<void> {
    if (this.bridgeArtwork.has(url) || this.artworkRequests.has(url) || Date.now() < (this.artworkRetryAt.get(url) ?? 0)) return
    const request = (async () => {
      const controller = new AbortController()
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const download = (async () => {
          const response = await fetch(url, { signal: controller.signal })
          const mime = response.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
          if (!response.ok || !/^image\/(jpeg|png|webp|gif)$/.test(mime)) throw Error('Invalid bridge artwork')
          const bytes = Buffer.from(await response.arrayBuffer())
          if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw Error('Invalid artwork size')
          return `data:${mime};base64,${bytes.toString('base64')}`
        })()
        const data = await Promise.race([download, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => { controller.abort(); reject(Error('Bridge artwork timed out')) }, 8000)
        })])
        this.bridgeArtwork.set(url, data)
        while (this.bridgeArtwork.size > 20) this.bridgeArtwork.delete(this.bridgeArtwork.keys().next().value!)
        if (this.bridgePlayback?.artworkKey === `bridge:${url}`) {
          this.bridgePlayback = { ...this.bridgePlayback, artworkUrl: data }
          this.metadata.setBridgeTrack(this.bridgePlayback)
        }
        if (this.queueArtworkUrl === url && this.bridgeQueue?.nextTrack) {
          this.bridgeQueue = { ...this.bridgeQueue, nextTrack: { ...this.bridgeQueue.nextTrack, artworkUrl: data } }
          this.publishQueue()
        }
      } catch (err) {
        if (!this.artworkRetryAt.has(url)) log('warn', 'Spotify cover download failed; retrying every 5 s', err)
        this.artworkRetryAt.set(url, Date.now() + 5000)
        while (this.artworkRetryAt.size > 20) this.artworkRetryAt.delete(this.artworkRetryAt.keys().next().value!)
      } finally { clearTimeout(timeout) }
    })()
    this.artworkRequests.set(url, request)
    try { await request } finally { this.artworkRequests.delete(url) }
  }

  private receive(packet: Record<string, unknown>): void {
    if (packet.type === 'hello' && typeof packet.version === 'string' && /^\d+\.\d+\.\d+$/.test(packet.version)) {
      const capabilities = Array.isArray(packet.capabilities) ? packet.capabilities : []
      this.expectsPlayback = capabilities.includes('playback')
      log('info', `Spotify bridge version ${packet.version.slice(0, 32)}; refresh support: ${capabilities.includes('refresh')}`)
      this.publish({ bridgeVersion: packet.version.slice(0, 32), bridgeNeedsUpdate: !['playback', 'queue', 'lyrics', 'refresh'].every(capability => capabilities.includes(capability)) })
      return
    }
    const queue = parseBridgeQueue(packet)
    if (queue !== undefined) {
      if (this.queueExpiry) clearTimeout(this.queueExpiry)
      this.queueExpiry = null
      this.queueArtworkUrl = queue?.nextTrack?.artworkUrl ?? null
      this.bridgeQueue = queue ? { ...queue, nextTrack: queue.nextTrack ? { ...queue.nextTrack,
        artworkUrl: this.queueArtworkUrl ? this.bridgeArtwork.get(this.queueArtworkUrl) ?? null : null } : null } : null
      this.publishQueue()
      if (this.queueArtworkUrl && settingsStore.get().spotify.showNextTrack) void this.loadBridgeArtwork(this.queueArtworkUrl)
      if (queue) this.queueExpiry = setTimeout(() => this.clearBridgeQueue(), 10000)
      return
    }
    const playback = parseBridgePlayback(packet)
    if (playback !== undefined) {
      this.lastPlaybackAt = Date.now()
      if (this.playbackExpiry) clearTimeout(this.playbackExpiry)
      this.playbackExpiry = null
      const remoteUrl = playback?.artworkUrl
      this.bridgePlayback = playback ? { ...playback, artworkUrl: remoteUrl ? this.bridgeArtwork.get(remoteUrl) ?? null : null } : null
      this.metadata.setBridgeTrack(this.bridgePlayback)
      if (remoteUrl) void this.loadBridgeArtwork(remoteUrl)
      if (playback) this.playbackExpiry = setTimeout(() => {
        log('warn', 'Spotify bridge playback snapshots stopped for 10s; requesting a fresh connection')
        this.clearBridgePlayback()
        this.socket?.terminate()
      }, 10000)
      return
    }
    // Legacy extensions may still send track packets. Only their lyrics are consumed.
    if (!['lyrics', 'track'].includes(String(packet.type)) || typeof packet.trackId !== 'string' || !/^[a-zA-Z0-9]{22}$/.test(packet.trackId)) return
    if (!['loading', 'resolved', 'disabled'].includes(String(packet.lyricsStatus))) return
    if (!settingsStore.get().lyrics.enabled) return
    const entry = { status: String(packet.lyricsStatus), lines: sanitizeLines(packet.lines) }
    this.bridgeLyrics.delete(packet.trackId)
    this.bridgeLyrics.set(packet.trackId, entry)
    if (this.bridgeLyrics.size > 200) this.bridgeLyrics.delete(this.bridgeLyrics.keys().next().value!)
    // Lyrics may arrive before the matching playback snapshot.
    // Buffer by ID, without changing any now-playing metadata.
    const track = this.metadata.getTrack()
    if (track.available && track.trackId === `spotify:${packet.trackId}`) this.applyBridgeLyrics(entry)
  }

  private applyBridgeLyrics(entry: { status: string; lines: LyricLine[] }): boolean {
    if (entry.lines.some((line) => line.text.trim())) {
      this.generation++; this.abort?.abort()
      if (this.fallbackTimer) clearTimeout(this.fallbackTimer)
      this.publish({ lines: entry.lines, source: 'spotify', status: 'ready', error: null })
      this.saveCache(this.currentKey, { at: Date.now(), source: 'spotify', lines: entry.lines })
      return true
    }
    if (entry.status === 'resolved' && this.state.source !== 'spotify') {
      if (this.fallbackTimer) clearTimeout(this.fallbackTimer)
      void this.resolve(this.metadata.getTrack(), this.generation)
      return true
    }
    return false
  }

  private onTrack(track: TrackInfo): void {
    const key = track.available ? keyOf(track) : ''
    if (key === this.currentKey && track.trackId === this.state.trackId) return
    this.currentKey = key
    const gen = ++this.generation
    this.abort?.abort()
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer)
    this.publish({ trackId: track.trackId, lines: [], source: null, status: key && settingsStore.get().lyrics.enabled ? 'loading' : 'idle', error: null })
    if (!key || !settingsStore.get().lyrics.enabled) return
    const buffered = track.trackId.startsWith('spotify:') ? this.bridgeLyrics.get(track.trackId.slice(8)) : undefined
    if (buffered && this.applyBridgeLyrics(buffered)) return
    // Give the desktop bridge first opportunity, including its asynchronous Spotify request.
    this.fallbackTimer = setTimeout(() => { void this.resolve(track, gen) }, this.socket ? 14000 : 2000)
  }

  private async resolve(track: TrackInfo, gen: number): Promise<void> {
    if (gen !== this.generation) return
    const key = keyOf(track)
    let cached = this.cache.get(key)
    if (!cached) {
      try {
        const raw = JSON.parse(await readFile(join(this.cacheDir, `${key}.json`), 'utf8'))
        const lines = sanitizeLines(raw.lines)
        if (Number.isFinite(raw.at) && Date.now() - raw.at < TTL && ['spotify','lrclib'].includes(raw.source) && lines.length) cached = { ...raw, lines }
      } catch { /* first play or expired cache */ }
    }
    if (gen !== this.generation) return
    if (cached && Date.now() - cached.at < TTL) {
      this.cache.set(key, cached)
      this.publish({ lines: cached.lines, source: cached.source, status: 'ready', error: null }); return
    }
    const controller = new AbortController(); this.abort?.abort(); this.abort = controller
    const timeout = setTimeout(() => controller.abort(), 10000)
    try {
      const params = new URLSearchParams({ track_name: track.title, artist_name: track.artist, album_name: track.album, duration: String(track.durationMs / 1000) })
      const response = await fetch(`https://lrclib.net/api/get?${params}`, { signal: controller.signal, headers: { 'User-Agent': `VibeSync/${app.getVersion()}` } })
      if (gen !== this.generation) return
      if (response.status === 404) { this.publish({ status: 'unavailable', error: null }); return }
      if (!response.ok) throw new Error(`LRCLIB returned ${response.status}`)
      const data = await response.json() as { syncedLyrics?: string }
      if (gen !== this.generation) return
      const lines = typeof data.syncedLyrics === 'string' ? parseLrc(data.syncedLyrics) : []
      if (!lines.some((l) => l.text.trim())) { this.publish({ status: 'unavailable', error: null }); return }
      this.publish({ lines, source: 'lrclib', status: 'ready', error: null })
      this.saveCache(key, { at: Date.now(), source: 'lrclib', lines })
    } catch {
      if (gen === this.generation) this.publish({ status: 'error', error: 'Lyrics could not be loaded. Check your internet connection or change the song to retry.' })
    } finally { clearTimeout(timeout) }
  }

  private saveCache(key: string, entry: CacheEntry): void {
    if (!key) return
    this.cache.set(key, entry)
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!)
    void (async () => {
      await mkdir(this.cacheDir, { recursive: true })
      const path = join(this.cacheDir, `${key}.json`)
      await writeFile(`${path}.tmp`, JSON.stringify(entry)); await rename(`${path}.tmp`, path)
    })().catch(() => log('warn', 'Could not cache lyrics'))
  }

  private async pruneCache(): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true })
      const files = await readdir(this.cacheDir)
      const entries = await Promise.all(files.filter((f) => /^[a-f0-9]{64}\.json$/.test(f)).map(async (f) => ({ path: join(this.cacheDir, f), time: (await stat(join(this.cacheDir,f))).mtimeMs })))
      entries.sort((a,b) => b.time - a.time)
      await Promise.all(entries.filter((e,i) => i >= 200 || Date.now() - e.time > TTL).map((e) => rm(e.path, { force: true })))
    } catch { /* cache is optional */ }
  }
}
