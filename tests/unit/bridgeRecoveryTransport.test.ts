import { afterEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { WebSocket, WebSocketServer } from 'ws'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'

const mocks = vi.hoisted(() => ({ server: null as any, settings: null as any }))
vi.mock('electron', () => ({ app: { getVersion: () => 'test', getPath: () => '/tmp/vibesync-recovery-transport' }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../src/main/settingsStore', () => ({ settingsStore: { get: () => mocks.settings, subscribe: () => () => {} } }))
vi.mock('../../src/main/logger', () => ({ log: vi.fn() }))
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), readdir: vi.fn(async () => []), stat: vi.fn(), rm: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), readFile: vi.fn(async () => { throw Error('no cache') }) }))
vi.mock('ws', async () => {
  const actual = await vi.importActual<typeof import('ws')>('ws')
  return { ...actual, WebSocketServer: class extends actual.WebSocketServer {
    constructor(options: any) { super({ ...options, port: 0 }); mocks.server = this }
  } }
})
import { LyricsService } from '../../src/main/lyricsService'
import { MetadataService } from '../../src/main/metadataService'

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Bridge response timed out')), 2000) })]) }
  finally { clearTimeout(timer) }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('background bridge recovery over real WebSockets', () => {
  it('keeps playback and queue current for six simulated minutes with client timers stopped, then recovers an abnormal close', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    mocks.settings = structuredClone(DEFAULT_SETTINGS)
    mocks.settings.lyrics.enabled = false
    const metadata = new MetadataService({} as any)
    const service = new LyricsService(metadata)
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    service.start()
    const server: WebSocketServer = mocks.server
    const clients: WebSocket[] = []
    let stopping = false
    let position = 0, paused = false
    const item = (id: string, title: string) => ({ uri: 'spotify:track:' + id.repeat(22), metadata: { title, artist_name: 'First', 'artist_name:1': 'Second', 'artist_name:2': 'Third', album_title: 'Album' } })
    const player = { data: { item: item('a', 'Current') }, getDuration: () => 600000, getProgress: () => position, isPlaying: () => !paused, addEventListener: vi.fn() }
    const state = { Player: player, Platform: {}, Queue: { track: player.data.item, nextTracks: [item('b', 'Next')] } }
    const pageInterval = vi.fn(), pageTimeout = vi.fn(() => 1)
    try {
      await bounded(once(server, 'listening'))
      const port = (server.address() as { port: number }).port
      class BrowserSocket extends WebSocket {
        constructor() {
          if (stopping) throw Error('Stopping test')
          super(`ws://127.0.0.1:${port}/vibesync`, { origin: 'https://xpui.app.spotify.com' })
          clients.push(this)
        }
      }
      const accepted = once(server, 'connection')
      await runInNewContext(readFileSync('spicetify/vibesync-bridge.js', 'utf8'), {
        Spicetify: state, WebSocket: BrowserSocket, Date, console, fetch: fetcher,
        setInterval: pageInterval, setTimeout: pageTimeout, clearTimeout: vi.fn()
      })
      let [socket] = await bounded(accepted) as [WebSocket]
      await vi.waitFor(() => expect(service.getQueue().nextTrack?.title).toBe('Next'))
      const waitForSnapshot = (current: WebSocket) => new Promise<void>(resolve => {
        const listener = (raw: Buffer) => {
          if (JSON.parse(raw.toString()).type === 'queue' && metadata.getTrack().positionMs === position) {
            current.off('message', listener); resolve()
          }
        }
        current.on('message', listener)
      })
      for (let second = 1; second <= 360; second++) {
        position = second * 1000
        if (second === 100) paused = true
        if (second === 110) paused = false
        if (second === 200) {
          player.data.item = item('c', 'Changed in background')
          state.Queue = { track: player.data.item, nextTracks: [item('d', 'Reordered next')] }
        }
        const updated = waitForSnapshot(socket)
        await vi.advanceTimersByTimeAsync(1000)
        await bounded(updated)
        expect(metadata.getTrack()).toMatchObject({ available: true, positionMs: position, status: paused ? 'paused' : 'playing', artist: 'First, Second, Third' })
      }
      expect(metadata.getTrack().title).toBe('Changed in background')
      expect(service.getQueue().nextTrack?.title).toBe('Reordered next')
      expect(service.getState()).toMatchObject({ bridgeConnected: true, bridgeVersion: '2.0.1', bridgeNeedsUpdate: false })
      const reconnected = once(server, 'connection')
      socket.terminate()
      ;[socket] = await bounded(reconnected) as [WebSocket]
      await vi.waitFor(() => expect(metadata.getTrack()).toMatchObject({ available: true, title: 'Changed in background' }))
      await vi.waitFor(() => expect(service.getQueue().nextTrack?.title).toBe('Reordered next'))
      expect(clients).toHaveLength(2)
      expect(pageTimeout.mock.calls.some(call => (call as unknown[])[1] === 3000)).toBe(false)
      expect(fetcher).not.toHaveBeenCalled()
      expect(pageInterval).toHaveBeenCalledTimes(1) // Registered, deliberately never executed.
    } finally {
      stopping = true
      const closed = once(server, 'close')
      for (const client of clients) client.terminate()
      service.stop()
      await bounded(closed)
    }
  })
})
