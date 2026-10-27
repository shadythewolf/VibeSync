/**
 * MetadataService - turns the helper's `track` / `artwork` messages into TrackInfo and
 * broadcasts it on IPC.trackChanged.
 *
 * Artwork handling:
 *   - `artwork` messages are written once to <userData>/artwork/<key>.<ext> and remembered
 *     as data: URLs in a small in-memory LRU (20 entries).
 *   - A `track` whose artworkKey is unknown is resolved from memory, then disk, and finally
 *     by asking the helper (`requestArtwork`); the track is re-broadcast when it arrives.
 *   - At startup the cache directory is pruned to 200 files / 50 MB (oldest first).
 */
import { BrowserWindow } from 'electron'
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import type { ArtworkMsg, HelperMessage, TrackMsg } from '../shared/protocol'
import { UNKNOWN_TRACK, type PlaybackStatus, type TrackInfo } from '../shared/types'
import type { HelperSupervisor } from './helperSupervisor'
import { log } from './logger'
import { getArtworkDir } from './paths'

const MAX_MEMORY_ENTRIES = 20
const MAX_CACHE_FILES = 200
const MAX_CACHE_BYTES = 50 * 1024 * 1024
const MAX_ARTWORK_BYTES = 8 * 1024 * 1024
const MAX_REQUESTED_KEYS = 64
const MAX_TEXT = 512
const KEY_RE = /^[a-f0-9]{8,128}$/i
const FILE_RE = /^([a-f0-9]{8,128})\.(jpg|png|gif|webp|bmp)$/i

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp'
}
const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp'
}
const EXTENSIONS = ['jpg', 'png', 'gif', 'webp', 'bmp'] as const

const PLAYBACK_STATUSES: readonly PlaybackStatus[] = ['playing', 'paused', 'stopped', 'changing', 'opening', 'closed', 'unknown']

/** Ordered (substring, friendly name) pairs; matched case-insensitively against the AppUserModelId. */
const APP_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['appleinc.applemusicwin', 'Apple Music'],
  ['itunes', 'iTunes'],
  ['spotify', 'Spotify'],
  ['microsoft.zunemusic', 'Media Player'],
  ['youtube', 'YouTube Music'],
  ['tidal', 'TIDAL'],
  ['deezer', 'Deezer'],
  ['amazon', 'Amazon Music'],
  ['foobar2000', 'foobar2000'],
  ['musicbee', 'MusicBee'],
  ['netflix', 'Netflix'],
  ['vlc', 'VLC'],
  ['msedge', 'Microsoft Edge'],
  ['brave', 'Brave'],
  ['opera', 'Opera'],
  ['vivaldi', 'Vivaldi'],
  ['firefox', 'Firefox'],
  ['chrome', 'Google Chrome']
]

export function friendlyAppName(sourceApp: string): string {
  if (!sourceApp) return ''
  const lower = sourceApp.toLowerCase()
  for (const [needle, name] of APP_NAMES) {
    if (lower.includes(needle)) return name
  }
  // Packaged app id "Publisher.AppName_publisherid!App" -> "AppName"; exe names lose ".exe".
  let s = sourceApp.replace(/_[a-z0-9]+![^!]*$/i, '').replace(/![^!]*$/, '')
  s = s.replace(/\.exe$/i, '')
  const dot = s.lastIndexOf('.')
  if (dot !== -1 && dot < s.length - 1) s = s.slice(dot + 1)
  return s.trim() || sourceApp
}

function text(v: unknown): string {
  return typeof v === 'string' ? (v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) : v) : ''
}

function nonNegative(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0
}

function extFor(contentType: unknown, bytes: Buffer): string {
  const ct = typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : ''
  const fromType = MIME_TO_EXT[ct]
  if (fromType) return fromType
  if (bytes.length >= 4) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg'
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif'
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp'
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  }
  return 'jpg'
}

export class MetadataService {
  private track: TrackInfo = UNKNOWN_TRACK
  private nativeTrack: TrackInfo = UNKNOWN_TRACK
  private listeners = new Set<(track: TrackInfo) => void>()
  private bridgeTrack: TrackInfo | null = null
  private readonly urls = new Map<string, string>()
  private readonly diskLookups = new Map<string, Promise<string | null>>()
  private readonly requested = new Set<string>()
  private writeChain: Promise<void> = Promise.resolve()
  private started = false

  constructor(private readonly supervisor: HelperSupervisor) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.supervisor.on('message', (msg) => this.onMessage(msg))
    this.supervisor.on('hello', () => {
      this.supervisor.send({ cmd: 'getTrack' })
    })
    this.supervisor.on('failed', () => this.setNativeTrack(UNKNOWN_TRACK))
    this.supervisor.on('exit', (info) => {
      if (info.expected) this.setNativeTrack(UNKNOWN_TRACK)
    })
    void this.prepareCacheDir()
  }

  getTrack(): TrackInfo {
    return this.track
  }

  subscribe(cb: (track: TrackInfo) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  setBridgeTrack(track: TrackInfo | null): void {
    this.bridgeTrack = track
    this.publishPreferredTrack()
  }

  private publishPreferredTrack(): void {
    this.publishTrack(this.bridgeTrack ?? this.nativeTrack)
  }

  /** Delete every cached artwork file and forget the in-memory URLs. */
  async clearCache(): Promise<void> {
    const dir = getArtworkDir()
    this.urls.clear()
    this.requested.clear()
    this.diskLookups.clear()
    await this.writeChain.catch(() => undefined)
    let removed = 0
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isFile() || !FILE_RE.test(e.name)) continue
        try {
          await rm(join(dir, e.name), { force: true })
          removed++
        } catch (err) {
          log('warn', `Could not delete artwork file ${e.name}`, err)
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        log('error', 'Could not clear the artwork cache', err)
        throw new Error('The artwork cache could not be cleared.')
      }
    }
    log('info', `Artwork cache cleared (${removed} file(s))`)
    if (this.nativeTrack.available && this.nativeTrack.artworkKey) {
      // Re-fetch the current artwork so the UI does not stay blank.
      const key = this.nativeTrack.artworkKey
      this.setNativeTrack({ ...this.nativeTrack, artworkUrl: null })
      this.requested.delete(key)
      this.supervisor.send({ cmd: 'requestArtwork', key })
    }
  }

  // ---------------------------------------------------------------------------
  // Helper messages
  // ---------------------------------------------------------------------------

  private onMessage(msg: HelperMessage): void {
    if (msg.type === 'track') this.onTrack(msg)
    else if (msg.type === 'artwork') this.onArtwork(msg)
  }

  private onTrack(msg: TrackMsg): void {
    if (msg.available !== true) {
      this.setNativeTrack(UNKNOWN_TRACK)
      return
    }
    const title = text(msg.title)
    const artist = text(msg.artist)
    const album = text(msg.album)
    const sourceApp = text(msg.sourceApp)
    const artworkKey = typeof msg.artworkKey === 'string' && KEY_RE.test(msg.artworkKey) ? msg.artworkKey.toLowerCase() : null
    const status: PlaybackStatus = (PLAYBACK_STATUSES as readonly string[]).includes(msg.status) ? msg.status : 'unknown'
    const positionUpdatedAt = nonNegative(msg.positionUpdatedAt) || Date.now()
    const info: TrackInfo = {
      available: true,
      title,
      artist,
      album,
      sourceApp,
      sourceAppName: friendlyAppName(sourceApp),
      status,
      positionMs: nonNegative(msg.positionMs),
      durationMs: nonNegative(msg.durationMs),
      positionUpdatedAt,
      artworkKey,
      artworkUrl: artworkKey ? this.rememberedUrl(artworkKey) : null,
      trackId: `${title}|${artist}|${album}`
    }
    if (info.trackId !== this.nativeTrack.trackId) {
      log('info', `Track: "${title}" - ${artist}${album ? ` (${album})` : ''} [${info.sourceAppName || sourceApp || 'unknown app'}]`)
    }
    this.setNativeTrack(info)
    if (artworkKey && !info.artworkUrl) this.resolveArtwork(artworkKey)
  }

  private onArtwork(msg: ArtworkMsg): void {
    if (typeof msg.key !== 'string' || !KEY_RE.test(msg.key)) {
      log('warn', 'Artwork message with invalid key ignored')
      return
    }
    const key = msg.key.toLowerCase()
    this.requested.delete(key)
    if (typeof msg.base64 !== 'string' || msg.base64.length === 0) {
      log('warn', `Artwork ${key} has no data`)
      return
    }
    if (msg.base64.length > (MAX_ARTWORK_BYTES * 4) / 3 + 4) {
      log('warn', `Artwork ${key} is too large (${msg.base64.length} base64 chars); ignored`)
      return
    }
    let bytes: Buffer
    try {
      bytes = Buffer.from(msg.base64, 'base64')
    } catch (err) {
      log('warn', `Artwork ${key} is not valid base64`, err)
      return
    }
    if (bytes.length === 0 || bytes.length > MAX_ARTWORK_BYTES) {
      log('warn', `Artwork ${key} has an unusable size (${bytes.length} bytes)`)
      return
    }
    const ext = extFor(msg.contentType, bytes)
    const mime = EXT_TO_MIME[ext]
    const url = `data:${mime};base64,${msg.base64}`
    this.remember(key, url)
    this.attachArtwork(key, url)
    this.persist(key, ext, bytes)
    log('debug', `Artwork ${key} received (${ext}, ${bytes.length} bytes)`)
  }

  // ---------------------------------------------------------------------------
  // Artwork cache
  // ---------------------------------------------------------------------------

  private rememberedUrl(key: string): string | null {
    const url = this.urls.get(key)
    if (url === undefined) return null
    // refresh LRU order
    this.urls.delete(key)
    this.urls.set(key, url)
    return url
  }

  private remember(key: string, url: string): void {
    this.urls.delete(key)
    this.urls.set(key, url)
    while (this.urls.size > MAX_MEMORY_ENTRIES) {
      const oldest = this.urls.keys().next().value
      if (oldest === undefined) break
      this.urls.delete(oldest)
    }
  }

  private attachArtwork(key: string, url: string): void {
    const t = this.nativeTrack
    if (!t.available || t.artworkKey !== key || t.artworkUrl === url) return
    this.setNativeTrack({ ...t, artworkUrl: url })
  }

  private resolveArtwork(key: string): void {
    if (this.diskLookups.has(key)) return
    const lookup = this.loadFromDisk(key)
      .then((url) => {
        if (url) {
          this.remember(key, url)
          this.attachArtwork(key, url)
        } else if (!this.requested.has(key)) {
          if (this.requested.size >= MAX_REQUESTED_KEYS) this.requested.clear()
          this.requested.add(key)
          this.supervisor.send({ cmd: 'requestArtwork', key })
        }
        return url
      })
      .catch((err: unknown) => {
        log('warn', `Artwork lookup for ${key} failed`, err)
        return null
      })
      .finally(() => {
        this.diskLookups.delete(key)
      })
    this.diskLookups.set(key, lookup)
  }

  private async loadFromDisk(key: string): Promise<string | null> {
    const dir = getArtworkDir()
    for (const ext of EXTENSIONS) {
      try {
        const bytes = await readFile(join(dir, `${key}.${ext}`))
        if (bytes.length === 0 || bytes.length > MAX_ARTWORK_BYTES) continue
        return `data:${EXT_TO_MIME[ext]};base64,${bytes.toString('base64')}`
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }
    return null
  }

  private persist(key: string, ext: string, bytes: Buffer): void {
    const dir = getArtworkDir()
    const file = join(dir, `${key}.${ext}`)
    this.writeChain = this.writeChain
      .then(async () => {
        try {
          await access(file)
          return // already cached
        } catch {
          /* not on disk yet */
        }
        await mkdir(dir, { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        await writeFile(tmp, bytes)
        await rename(tmp, file)
      })
      .catch((err: unknown) => log('warn', `Could not cache artwork ${key}`, err))
  }

  private async prepareCacheDir(): Promise<void> {
    const dir = getArtworkDir()
    try {
      await mkdir(dir, { recursive: true })
    } catch (err) {
      log('warn', 'Could not create the artwork cache directory', err)
      return
    }
    try {
      await this.prune(dir)
    } catch (err) {
      log('warn', 'Artwork cache prune failed', err)
    }
  }

  private async prune(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    const files: Array<{ path: string; size: number; mtime: number }> = []
    let total = 0
    for (const e of entries) {
      if (!e.isFile()) continue
      const path = join(dir, e.name)
      if (e.name.endsWith('.tmp')) {
        await rm(path, { force: true }).catch(() => undefined)
        continue
      }
      if (!FILE_RE.test(e.name)) continue
      try {
        const s = await stat(path)
        files.push({ path, size: s.size, mtime: s.mtimeMs })
        total += s.size
      } catch {
        /* vanished between readdir and stat */
      }
    }
    if (files.length <= MAX_CACHE_FILES && total <= MAX_CACHE_BYTES) return
    files.sort((a, b) => a.mtime - b.mtime)
    let removed = 0
    let count = files.length
    for (const f of files) {
      if (count <= MAX_CACHE_FILES && total <= MAX_CACHE_BYTES) break
      try {
        await rm(f.path, { force: true })
        removed++
        count--
        total -= f.size
      } catch (err) {
        log('warn', `Could not prune artwork file ${f.path}`, err)
      }
    }
    log('info', `Artwork cache pruned: removed ${removed} file(s), ${count} left (${(total / 1024 / 1024).toFixed(1)} MB)`)
  }

  // ---------------------------------------------------------------------------
  // Broadcast
  // ---------------------------------------------------------------------------

  private setNativeTrack(track: TrackInfo): void {
    this.nativeTrack = track
    this.publishPreferredTrack()
  }

  private publishTrack(track: TrackInfo): void {
    if (track === this.track) return
    if (!track.available && !this.track.available) return
    this.track = track
    for (const cb of this.listeners) cb(track)
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send(IPC.trackChanged, track)
      } catch (err) {
        log('warn', 'track:changed broadcast failed', err)
      }
    }
  }
}
