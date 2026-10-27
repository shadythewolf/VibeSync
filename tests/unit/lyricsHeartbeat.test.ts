import { afterEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { UNKNOWN_TRACK, type TrackInfo } from '../../src/shared/types'

const mocks = vi.hoisted(() => ({ server: null as any }))
vi.mock('electron', () => ({ app: { getVersion: () => 'test', getPath: () => '/tmp/vibesync-heartbeat-unit' }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../src/main/settingsStore', () => ({ settingsStore: { get: () => DEFAULT_SETTINGS, subscribe: () => () => {} } }))
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

async function withTimeout<T>(event: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([event, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('WebSocket event timed out')), 2000) })]) }
  finally { clearTimeout(timer) }
}

afterEach(() => vi.useRealTimers())

describe('lyrics bridge transport heartbeat', () => {
  it.each(['/vibesync', '/vibedeck'])('retains Spotify metadata without JS position updates on %s', async (bridgePath) => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const track: TrackInfo = { ...UNKNOWN_TRACK, available:true, trackId:'spotify:'+'a'.repeat(22), title:'Heartbeat test', artist:'First, Second, Third', album:'', durationMs:120000, positionMs:1000, status:'paused' }
    const metadata = { setBridgeTrack: vi.fn(), getTrack: () => track, subscribe: () => () => {} }
    const service = new LyricsService(metadata as any)
    service.start()
    const server: WebSocketServer = mocks.server
    let client: WebSocket | undefined
    try {
      await withTimeout(once(server, 'listening'))
      const address = server.address() as { port: number }
      const accepted = once(server, 'connection')
      client = new WebSocket(`ws://127.0.0.1:${address.port}${bridgePath}`, { origin: 'https://xpui.app.spotify.com' })
      await withTimeout(once(client, 'open'))
      const [socket] = await withTimeout(accepted) as [WebSocket]
      client.send(JSON.stringify({ type: 'lyrics', trackId: 'a'.repeat(22), lyricsStatus: 'resolved', lines: [{ timeMs: 1000, text: 'Retained line' }] }))
      await vi.waitFor(() => expect(service.getState().source).toBe('spotify'))
      for (let i = 0; i < 8; i++) {
        const pong = once(socket, 'pong')
        await vi.advanceTimersByTimeAsync(15000)
        await withTimeout(pong)
        expect(service.getState().bridgeConnected).toBe(true)
      }
      expect(service.getState()).toMatchObject({ source: 'spotify', status: 'ready', lines: [{ timeMs: 1000, text: 'Retained line' }] })
      expect(metadata.getTrack()).toMatchObject({ trackId: 'spotify:' + 'a'.repeat(22), status: 'paused', positionMs: 1000, artist:'First, Second, Third' })
      expect(metadata.getTrack()).toBe(track)
    } finally {
      const closed = once(server, 'close')
      client?.terminate()
      service.stop()
      await withTimeout(closed)
    }
  })
})

describe('real local Spotify bridge transport', () => {
  it('updates metadata, artists and lyric timing through actual WebSocket packets without a Web API connection', async () => {
    const metadata = new MetadataService({} as any)
    const service = new LyricsService(metadata)
    service.start()
    const server: WebSocketServer = mocks.server
    let client: WebSocket | undefined
    try {
      await withTimeout(once(server,'listening'))
      const address = server.address() as {port:number}
      client = new WebSocket(`ws://127.0.0.1:${address.port}/vibesync`,{origin:'https://xpui.app.spotify.com'})
      await withTimeout(once(client,'open'))
      const id='b'.repeat(22)
      client.send(JSON.stringify({type:'playback',available:true,trackId:id,title:'Local playback',artists:['One','Two','Three'],album:'Album',durationMs:120000,positionMs:42000,paused:false}))
      client.send(JSON.stringify({type:'queue',available:true,trackId:id,nextTrack:{trackId:'c'.repeat(22),title:'Next locally',artists:['Four','Five'],album:'Next album'}}))
      client.send(JSON.stringify({type:'lyrics',trackId:id,lyricsStatus:'resolved',lines:[{timeMs:42000,text:'In sync'}]}))
      await vi.waitFor(()=>expect(metadata.getTrack()).toMatchObject({title:'Local playback',artist:'One, Two, Three',positionMs:42000,status:'playing'}))
      await vi.waitFor(()=>expect(service.getState()).toMatchObject({source:'spotify',status:'ready',lines:[{timeMs:42000,text:'In sync'}]}))
      client.send(JSON.stringify({type:'playback',available:true,trackId:id,title:'Local playback',artists:['One','Two','Three'],album:'Album',durationMs:120000,positionMs:90000,paused:true}))
      await vi.waitFor(()=>expect(metadata.getTrack()).toMatchObject({positionMs:90000,status:'paused'}))
      await vi.waitFor(()=>expect(service.getQueue()).toMatchObject({currentTrackId:'spotify:'+id,nextTrack:{title:'Next locally',artist:'Four, Five'}}))
      client.close()
      await vi.waitFor(()=>expect(metadata.getTrack().available).toBe(false))
      expect(service.getQueue().nextTrack).toBeNull()
    } finally {
      const closed=once(server,'close')
      client?.terminate();service.stop()
      await withTimeout(closed)
    }
  })
})
