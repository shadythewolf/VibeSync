import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { UNKNOWN_TRACK, type TrackInfo } from '../../src/shared/types'

const mocks = vi.hoisted(() => ({ server: null as any, settings: null as any, settingsChanged: null as any, sent: [] as any[] }))
vi.mock('electron', () => ({ app: { getVersion: () => 'test', getPath: () => '/tmp/vibedeck-lyrics-unit' }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../src/main/settingsStore', () => ({ settingsStore: { get: () => mocks.settings, subscribe: (cb: any) => { mocks.settingsChanged=cb; return () => {} } } }))
vi.mock('../../src/main/logger', () => ({ log: vi.fn() }))
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), readdir: vi.fn(async () => []), stat: vi.fn(), rm: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), readFile: vi.fn(async () => { throw Error('no cache') }) }))
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  return { WebSocket: { OPEN: 1 }, WebSocketServer: class extends EventEmitter {
    constructor(public options: any) { super(); mocks.server = this }
    close() {}
  } }
})
import { MetadataService } from '../../src/main/metadataService'
import { LyricsService } from '../../src/main/lyricsService'

const currentTrack = (id = 'a'.repeat(22), title = 'One'): TrackInfo => ({ ...UNKNOWN_TRACK, available:true, trackId:'spotify:'+id, title, artist:'First, Second, Third', album:'Album', durationMs:120000, positionMs:1000, status:'playing', artworkUrl:'data:image/png;base64,abcd', artworkKey:'abcd1234' })
const packet = (id = 'a'.repeat(22), _title = 'One', lines: unknown[] = [], lyricsStatus = 'loading') => ({ type:'lyrics', trackId:id, lyricsStatus, lines })

function fixture(respondToPing = true) {
  const metadata = new MetadataService({} as any)
  metadata.setBridgeTrack(currentTrack())
  const service = new LyricsService(metadata as any)
  service.start()
  const socket = Object.assign(new EventEmitter(), { readyState:1, send:(data: string) => mocks.sent.push(JSON.parse(data)), terminate: vi.fn(() => socket.emit('close')), ping: vi.fn(() => { if (respondToPing) socket.emit('pong') }) })
  mocks.server.emit('connection', socket)
  return { service, metadata, socket, receive: (value: unknown) => socket.emit('message', Buffer.from(JSON.stringify(value))) }
}

beforeEach(() => { vi.useFakeTimers(); mocks.settings = structuredClone(DEFAULT_SETTINGS); mocks.sent = [] })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('lyrics provider coordination', () => {
  it('binds only to loopback, waits for Spotify, follows pause/seek, and uses cache on revisit', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const f = fixture()
    expect(mocks.server.options.host).toBe('127.0.0.1')
    expect(mocks.server.options.verifyClient({origin:'https://evil.example', req:{socket:{remoteAddress:'127.0.0.1'}}})).toBe(false)
    f.receive(packet())
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetcher).not.toHaveBeenCalled()
    f.receive(packet('a'.repeat(22),'One',[{timeMs:1000,text:'Spotify line'}],'resolved'))
    expect(f.service.getState()).toMatchObject({source:'spotify',status:'ready'})
    f.receive({type:'position',trackId:'a'.repeat(22),positionMs:70000,paused:true})
    expect(f.metadata.getTrack()).toMatchObject({positionMs:1000,status:'playing',artist:'First, Second, Third'})
    f.metadata.setBridgeTrack({...f.metadata.getTrack(),positionMs:70000,status:'paused'})
    expect(f.service.getState().lines[0].text).toBe('Spotify line')
    f.metadata.setBridgeTrack(currentTrack('b'.repeat(22),'Two'))
    f.receive(packet('b'.repeat(22),'Two'))
    expect(f.service.getState().lines).toEqual([])
    f.metadata.setBridgeTrack(currentTrack())
    f.receive(packet('a'.repeat(22),'One',[],'resolved'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.service.getState().source).toBe('spotify')
    expect(fetcher).not.toHaveBeenCalled()
    f.service.stop()
  })
  it('falls back to synced LRCLIB and ignores a late reply after the song changes', async () => {
    let finish: (value: unknown) => void = () => {}
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValue({ok:true,status:200,json:async () => ({syncedLyrics:'[00:01.00]Fallback'})})
    vi.stubGlobal('fetch', fetcher)
    const f = fixture()
    f.metadata.setBridgeTrack(currentTrack())
    f.receive(packet('a'.repeat(22),'One',[],'resolved'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
    f.metadata.setBridgeTrack(currentTrack('b'.repeat(22),'Two'))
    f.receive(packet('b'.repeat(22),'Two',[],'resolved'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.service.getState()).toMatchObject({trackId:'spotify:'+'b'.repeat(22),source:'lrclib',lines:[{timeMs:1000,text:'Fallback'}]})
    finish({ok:true,status:200,json:async () => ({syncedLyrics:'[00:01]Old song'})})
    await vi.advanceTimersByTimeAsync(0)
    expect(f.service.getState().lines[0].text).toBe('Fallback')
    f.service.stop()
  })
  it('keeps a healthy bridge connected when Spotify stops sending position updates', async () => {
    const f = fixture()
    f.receive(packet('a'.repeat(22), 'One', [{ timeMs: 1000, text: 'Spotify line' }], 'resolved'))
    await vi.advanceTimersByTimeAsync(120000)
    expect(f.service.getState()).toMatchObject({ bridgeConnected: true, source: 'spotify', status: 'ready' })
    expect(f.metadata.getTrack().trackId).toBe('spotify:' + 'a'.repeat(22))
    expect(f.socket.terminate).not.toHaveBeenCalled()
    expect(f.socket.ping).toHaveBeenCalled()
    f.service.stop()
  })
  it('ignores legacy metadata fields and clears playback after disconnect', () => {
    const f = fixture()
    const canonical = f.metadata.getTrack()
    f.receive({...packet(),type:'track',title:'Wrong',artist:'Only one',album:'Wrong',durationMs:1,positionMs:90000,paused:true,artworkUrl:'https://i.scdn.co/image/wrong'})
    f.receive({type:'position',trackId:'a'.repeat(22),positionMs:90000,paused:true})
    f.receive({type:'clear'})
    expect(f.metadata.getTrack()).toBe(canonical)
    f.socket.emit('close',1000)
    expect(f.metadata.getTrack().available).toBe(false)
    expect(canonical.artist).toBe('First, Second, Third')
    f.service.stop()
  })
  it('buffers early lyrics without applying them to a different current track', () => {
    const f = fixture()
    f.receive(packet('a'.repeat(22),'One',[{timeMs:1000,text:'Current'}],'resolved'))
    f.receive(packet('b'.repeat(22),'Two',[{timeMs:2000,text:'Next'}],'resolved'))
    expect(f.service.getState().lines[0].text).toBe('Current')
    expect(f.metadata.getTrack().trackId).toBe('spotify:'+'a'.repeat(22))
    f.metadata.setBridgeTrack(currentTrack('b'.repeat(22),'Two'))
    expect(f.service.getState()).toMatchObject({trackId:'spotify:'+'b'.repeat(22),source:'spotify',lines:[{timeMs:2000,text:'Next'}]})
    f.receive(packet('a'.repeat(22),'One',[{timeMs:0,text:'Late old song'}],'resolved'))
    expect(f.service.getState().lines[0].text).toBe('Next')
    f.service.stop()
  })
  it('makes no lyrics requests when disabled and expires a stale bridge connection', async () => {
    mocks.settings.lyrics.enabled = false
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const f = fixture(false)
    f.metadata.setBridgeTrack(currentTrack())
    f.receive(packet('a'.repeat(22),'One',[],'resolved'))
    expect(mocks.sent[0]).toEqual({type:'config',enabled:false,requestSnapshots:true})
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.service.getState().bridgeConnected).toBe(true)
    await vi.advanceTimersByTimeAsync(30000)
    expect(fetcher).not.toHaveBeenCalled()
    expect(f.service.getState().bridgeConnected).toBe(false)
    f.service.stop()
  })
})

const playbackPacket = (id = 'b'.repeat(22), extra = {}) => ({ type:'playback', available:true, trackId:id, title:'Bridge song', artists:['First','Second','Third'], album:'Bridge album', durationMs:120000, positionMs:42000, paused:false, ...extra })

describe('bridge playback authority', () => {
  it('supplies playback and lyrics together without an API login', () => {
    const f = fixture()
    f.metadata.setBridgeTrack(null)
    f.receive(packet('b'.repeat(22), '', [{timeMs:40000,text:'Bridge lyric'}], 'resolved'))
    f.receive(playbackPacket())
    expect(f.metadata.getTrack().trackId).toBe('spotify:'+'b'.repeat(22))
    expect(f.service.getState()).toMatchObject({source:'spotify',status:'ready',lines:[{timeMs:40000,text:'Bridge lyric'}]})
    f.service.stop()
  })
  it('works with lyrics disabled and rejects invalid and legacy metadata', () => {
    mocks.settings.lyrics.enabled = false
    const f = fixture()
    f.metadata.setBridgeTrack(null)
    f.receive(playbackPacket())
    const valid = f.metadata.getTrack()
    f.receive(playbackPacket('invalid'))
    f.receive({...playbackPacket(),type:'track'})
    f.receive(playbackPacket('b'.repeat(22),{title:'',positionMs:Infinity}))
    expect(f.metadata.getTrack()).toBe(valid)
    expect(f.service.getState().status).toBe('idle')
    f.service.stop()
  })
  it('restarts the connection when playback snapshots stop despite transport pongs', async () => {
    mocks.settings.lyrics.enabled = false
    const f = fixture()
    f.metadata.setBridgeTrack(null)
    f.receive(playbackPacket())
    await vi.advanceTimersByTimeAsync(9000)
    f.receive(playbackPacket('b'.repeat(22),{positionMs:51000}))
    await vi.advanceTimersByTimeAsync(9000)
    expect(f.metadata.getTrack().available).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.metadata.getTrack().available).toBe(false)
    expect(f.service.getState().bridgeConnected).toBe(false)
    expect(f.socket.terminate).toHaveBeenCalled()
    f.service.stop()
  })
  it.each(['clear','close'])('clears fallback playback on %s', action => {
    const f = fixture()
    f.metadata.setBridgeTrack(null)
    f.receive(playbackPacket())
    if (action === 'close') f.socket.emit('close',1000)
    else f.receive({type:'playback',available:false})
    expect(f.metadata.getTrack().available).toBe(false)
    f.service.stop()
  })
  it('downloads artwork once, uses data URLs, and preserves the latest position', async () => {
    let finish: (v: unknown) => void = () => {}
    const fetcher = vi.fn(() => new Promise(resolve => { finish = resolve }))
    vi.stubGlobal('fetch',fetcher)
    mocks.settings.lyrics.enabled = false
    const f = fixture()
    f.metadata.setBridgeTrack(null)
    const artworkUrl = 'https://i.scdn.co/image/test'
    f.receive(playbackPacket('b'.repeat(22),{artworkUrl}))
    f.receive(playbackPacket('b'.repeat(22),{artworkUrl,positionMs:45000,paused:true}))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(f.metadata.getTrack().artworkUrl).toBeNull()
    finish({ok:true,headers:{get:()=> 'image/png'},arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer})
    await vi.advanceTimersByTimeAsync(0)
    expect(f.metadata.getTrack()).toMatchObject({artworkUrl:'data:image/png;base64,AQID',positionMs:45000,status:'paused'})
    f.receive(playbackPacket('b'.repeat(22),{artworkUrl,positionMs:46000}))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(f.metadata.getTrack().artworkUrl).toBe('data:image/png;base64,AQID')
    f.service.stop()
  })
  it('does not apply late artwork to another song or after disconnect', async () => {
    let finish: (v: unknown) => void = () => {}
    vi.stubGlobal('fetch',vi.fn(() => new Promise(resolve => { finish = resolve })))
    mocks.settings.lyrics.enabled = false
    const f = fixture()
    f.metadata.setBridgeTrack(null)
    f.receive(playbackPacket('b'.repeat(22),{artworkUrl:'https://i.scdn.co/image/test'}))
    f.receive(playbackPacket('c'.repeat(22)))
    finish({ok:true,headers:{get:()=> 'image/png'},arrayBuffer:async()=>new Uint8Array([1]).buffer})
    await vi.advanceTimersByTimeAsync(0)
    expect(f.metadata.getTrack()).toMatchObject({trackId:'spotify:'+'c'.repeat(22),artworkUrl:null})
    f.socket.emit('close',1000)
    expect(f.metadata.getTrack().available).toBe(false)
    f.service.stop()
  })
})

const queuePacket = (title = 'Next song', extra = {}) => ({ type:'queue',available:true,trackId:'b'.repeat(22),nextTrack:{trackId:'c'.repeat(22),title,artists:['One','Two','Three'],album:'Next album',...extra} })
describe('local bridge queue', () => {
  it('updates Up Next and reordered queues with every artist even when lyrics are disabled', () => {
    mocks.settings.lyrics.enabled=false
    const f=fixture()
    f.receive(playbackPacket())
    f.receive(queuePacket())
    expect(f.service.getQueue()).toMatchObject({currentTrackId:'spotify:'+'b'.repeat(22),nextTrack:{title:'Next song',artist:'One, Two, Three',album:'Next album'},error:null})
    f.receive(queuePacket('Reordered'))
    expect(f.service.getQueue().nextTrack?.title).toBe('Reordered')
    f.receive({...queuePacket(),nextTrack:null})
    expect(f.service.getQueue().nextTrack).toBeNull()
    f.service.stop()
  })
  it('preserves the toggle and suppresses artwork downloads while Up Next is disabled', async () => {
    mocks.settings.lyrics.enabled=false;mocks.settings.spotify.showNextTrack=false
    const fetcher=vi.fn().mockResolvedValue({ok:true,headers:{get:()=> 'image/png'},arrayBuffer:async()=>new Uint8Array([1]).buffer})
    vi.stubGlobal('fetch',fetcher)
    const f=fixture()
    f.receive(queuePacket('Next song',{artworkUrl:'https://i.scdn.co/image/next'}))
    expect(f.service.getQueue().nextTrack).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
    const prev=structuredClone(mocks.settings)
    mocks.settings.spotify.showNextTrack=true
    mocks.settingsChanged(mocks.settings,prev)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.service.getQueue().nextTrack).toMatchObject({title:'Next song',artworkUrl:'data:image/png;base64,AQ=='})
    f.service.stop()
  })
  it('expires stale queues independently of current playback', async () => {
    mocks.settings.lyrics.enabled=false
    const f=fixture()
    f.receive(playbackPacket());f.receive(queuePacket())
    await vi.advanceTimersByTimeAsync(9000)
    f.receive(playbackPacket())
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.service.getQueue().nextTrack).toBeNull()
    expect(f.metadata.getTrack().available).toBe(true)
    expect(f.service.getState().bridgeConnected).toBe(true)
    f.service.stop()
  })
  it.each(['unavailable','close'])('clears Up Next on %s', action => {
    mocks.settings.lyrics.enabled=false
    const f=fixture();f.receive(playbackPacket());f.receive(queuePacket())
    if(action==='close')f.socket.emit('close',1000)
    else f.receive({type:'queue',available:false})
    expect(f.service.getQueue().nextTrack).toBeNull()
    f.service.stop()
  })
  it('does not attach a late cover to a reordered or cleared queue', async () => {
    mocks.settings.lyrics.enabled=false
    let finish: (v: any)=>void=()=>{}
    const fetcher=vi.fn(()=>new Promise(resolve=>{finish=resolve}))
    vi.stubGlobal('fetch',fetcher)
    const f=fixture();f.receive(queuePacket('Old next',{artworkUrl:'https://i.scdn.co/image/old'}))
    f.receive(queuePacket('New next'))
    finish({ok:true,headers:{get:()=> 'image/png'},arrayBuffer:async()=>new Uint8Array([1]).buffer})
    await vi.advanceTimersByTimeAsync(0)
    expect(f.service.getQueue().nextTrack).toMatchObject({title:'New next',artworkUrl:null})
    f.receive({type:'queue',available:false})
    expect(f.service.getQueue().nextTrack).toBeNull()
    f.service.stop()
  })
  it('shares the artwork cache between playback and Up Next', async () => {
    mocks.settings.lyrics.enabled=false
    const fetcher=vi.fn().mockResolvedValue({ok:true,headers:{get:()=> 'image/png'},arrayBuffer:async()=>new Uint8Array([1]).buffer})
    vi.stubGlobal('fetch',fetcher)
    const f=fixture(),artworkUrl='https://i.scdn.co/image/shared'
    f.receive(playbackPacket('b'.repeat(22),{artworkUrl}));f.receive(queuePacket('Next',{artworkUrl}))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(f.metadata.getTrack().artworkUrl).toBe('data:image/png;base64,AQ==')
    expect(f.service.getQueue().nextTrack?.artworkUrl).toBe('data:image/png;base64,AQ==')
    f.service.stop()
  })
})

describe('native metadata fallback',()=>{
 it('returns to the native helper after the bridge disconnects',()=>{
  const helper=Object.assign(new EventEmitter(),{send:vi.fn()})
  const metadata=new MetadataService(helper as any);metadata.start()
  helper.emit('message',{type:'track',available:true,title:'Native song',artist:'Native artist',album:'Album',sourceApp:'vlc.exe',status:'playing',durationMs:120000,positionMs:1000,positionUpdatedAt:Date.now(),artworkKey:null})
  const native=metadata.getTrack()
  metadata.setBridgeTrack(currentTrack())
  expect(metadata.getTrack().title).toBe('One')
  helper.emit('message',{type:'track',available:false})
  expect(metadata.getTrack().title).toBe('One')
  helper.emit('message',{type:'track',available:true,title:native.title,artist:native.artist,album:'Album',sourceApp:'vlc.exe',status:'playing',durationMs:120000,positionMs:2000,positionUpdatedAt:Date.now(),artworkKey:null})
  metadata.setBridgeTrack(null)
  expect(metadata.getTrack()).toMatchObject({title:'Native song',artist:'Native artist',positionMs:2000})
 })
})

describe('bridge version detection',()=>{
 it('marks old bridges for update and accepts the complete new protocol',()=>{
  const f=fixture()
  expect(f.service.getState()).toMatchObject({bridgeConnected:true,bridgeNeedsUpdate:true})
  f.receive({type:'hello',version:'2.0.1',capabilities:['playback','queue','lyrics','refresh']})
  expect(f.service.getState()).toMatchObject({bridgeVersion:'2.0.1',bridgeNeedsUpdate:false})
  f.receive({type:'hello',version:'1.1.0',capabilities:['playback','lyrics']})
  expect(f.service.getState().bridgeNeedsUpdate).toBe(true)
  f.service.stop()
 })
})

describe('application-driven bridge refresh',()=>{
 it('requests fresh local snapshots even when lyrics are off',async()=>{
  mocks.settings.lyrics.enabled=false
  const f=fixture()
  await vi.advanceTimersByTimeAsync(5000)
  expect(mocks.sent.filter(packet=>packet.type==='refresh')).toHaveLength(5)
  f.service.stop()
  const count=mocks.sent.length
  await vi.advanceTimersByTimeAsync(5000)
  expect(mocks.sent).toHaveLength(count)
 })
 it('restarts a bridge that announces playback but never sends a snapshot',async()=>{
  mocks.settings.lyrics.enabled=false
  const f=fixture()
  f.receive({type:'hello',version:'2.0.1',capabilities:['playback','queue','lyrics','refresh']})
  await vi.advanceTimersByTimeAsync(15000)
  expect(f.socket.terminate).toHaveBeenCalled()
  expect(f.service.getState().bridgeConnected).toBe(false)
  f.service.stop()
 })
})
