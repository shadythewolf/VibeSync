import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const code = readFileSync(new URL('../../spicetify/vibesync-bridge.js', import.meta.url), 'utf8')
function setup(options: { failBuilder?: boolean; legacyLoaded?: boolean } = {}) {
  const sent: any[] = []
  const intervals: Array<() => void> = []
  const timeouts: Array<{ cb: () => void; delay: number }> = []
  const sockets: any[] = []
  const events: Record<string,()=>void> = {}
  let socket: any
  const id = 'a'.repeat(22)
  const body = {lyrics:{syncType:'LINE_SYNCED',lines:[{startTimeMs:'1000',words:'One'}]}}
  const get = vi.fn(async()=>body)
  const send = vi.fn(async()=>{if(options.failBuilder) throw Error('older client'); return {body}})
  const builder: any = {withHost:vi.fn(()=>builder),withPath:vi.fn(()=>builder),withQueryParameters:vi.fn(()=>builder),withEndpointIdentifier:vi.fn(()=>builder),send}
  const player = {data:{item:{uri:`spotify:track:${id}`,metadata:{title:'Title',artist_name:'First',artist_name1:'Second',album_title:'Album',image_url:'spotify:image:123abc'}}},getDuration:()=>120000,getProgress:()=>1000,isPlaying:()=>false,addEventListener:vi.fn()}
  const fetcher = vi.fn(async()=>({ok:false,status:401}))
  const context = {Date,addEventListener:(name:string,cb:()=>void)=>{events[name]=cb},clearTimeout:vi.fn(),__vibeDeckBridge:options.legacyLoaded,Spicetify:{Player:player,Platform:{RequestBuilder:{build:()=>builder},AuthorizationAPI:{getState:()=>({token:{accessToken:'test-session'}})}},CosmosAsync:{get}},WebSocket:class {
    static CONNECTING=0;static OPEN=1;readyState=1;onmessage:any;onclose:any;onerror:any
    constructor(public address:string) {socket=this;sockets.push(this)}
    send(data:string) {sent.push(JSON.parse(data))}
    close=vi.fn(() => {this.readyState=3;this.onclose?.()})
  },setInterval:(cb:()=>void)=>{intervals.push(cb)},setTimeout:(cb:()=>void,delay:number)=>{timeouts.push({cb,delay});return timeouts.length},AbortSignal,fetch:fetcher,console}
  runInNewContext(code,context)
  return {sent,intervals,socket,sockets,timeouts,send,get,player,fetcher,builder,events}
}

describe('Spicetify bridge',()=>{
  it('keeps lyrics working independently of temporarily unavailable playback metadata',async()=>{
    const f=setup()
    expect(f.socket.address).toBe('ws://127.0.0.1:43821/vibesync')
    Object.defineProperty(f.player.data.item, 'metadata', { get: () => { throw Error('Metadata is outside the bridge scope') } })
    f.player.getProgress = () => { throw Error('Position is outside the bridge scope') }
    f.player.getDuration = () => { throw Error('Duration is outside the bridge scope') }
    f.player.isPlaying = () => { throw Error('Playback is outside the bridge scope') }
    f.socket.onmessage({data:JSON.stringify({type:'config',enabled:true})})
    await vi.waitFor(()=>expect(f.sent.at(-1).lyricsStatus).toBe('resolved'))
    expect(f.sent.at(-1)).toEqual({type:'lyrics',trackId:'a'.repeat(22),lyricsStatus:'resolved',lines:[{timeMs:1000,text:'One'}]})
    expect(f.player.addEventListener.mock.calls.map(call => call[0])).toEqual(['songchange', 'onplaypause'])
    expect(f.builder.withHost).toHaveBeenCalledWith('https://spclient.wg.spotify.com/color-lyrics/v2')
    expect(f.fetcher).not.toHaveBeenCalled()
    f.socket.onmessage({data:JSON.stringify({type:'config',enabled:true})})
    await vi.waitFor(()=>expect(f.sent.at(-1).lyricsStatus).toBe('resolved'))
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.sent)).not.toContain('test-session')
  })
  it('supports CosmosAsync on older clients and makes no requests when lyrics are off',async()=>{
    const f=setup({failBuilder:true})
    f.socket.onmessage({data:JSON.stringify({type:'config',enabled:false})})
    expect(f.send).not.toHaveBeenCalled()
    f.socket.onmessage({data:JSON.stringify({type:'config',enabled:true})})
    await vi.waitFor(()=>expect(f.sent.at(-1).lyricsStatus).toBe('resolved'))
    expect(f.get).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.sent)).not.toContain('test-session')
  })
  it('reconnects once and ignores late events from the previous socket', async () => {
    const f = setup()
    const first = f.socket
    first.close()
    first.onclose()
    const retries = f.timeouts.filter(t => t.delay === 3000)
    expect(retries).toHaveLength(1)
    retries[0].cb()
    expect(f.sockets).toHaveLength(2)
    const next = f.sockets[1]
    next.onmessage({ data: JSON.stringify({ type: 'config', enabled: true }) })
    await vi.waitFor(() => expect(f.sent.at(-1).lyricsStatus).toBe('resolved'))
    first.onerror()
    first.onclose()
    first.onmessage({ data: JSON.stringify({ type: 'config', enabled: false }) })
    expect(next.close).not.toHaveBeenCalled()
    expect(f.timeouts.filter(t => t.delay === 3000)).toHaveLength(1)
    const count = f.sent.length
    f.intervals[0]()
    expect(f.sent).toHaveLength(count + 2)
    expect(f.sent.at(-1).type).toBe('queue')
    next.close()
    next.onclose()
    expect(f.timeouts.filter(t => t.delay === 3000)).toHaveLength(1)
    expect(f.sockets).toHaveLength(3)
  })
  it('tolerates a temporary Spotify player API failure without disconnecting', async () => {
    const f = setup()
    f.socket.onmessage({ data: JSON.stringify({ type: 'config', enabled: true }) })
    await vi.waitFor(() => expect(f.sent.at(-1).lyricsStatus).toBe('resolved'))
    const item = f.player.data.item
    let unavailable = true
    Object.defineProperty(f.player.data, 'item', { get: () => { if (unavailable) { unavailable = false; throw Error('Player is loading') }; return item } })
    f.intervals[0]()
    await Promise.resolve()
    await Promise.resolve()
    f.intervals[0]()
    expect(f.sent.at(-1).type).toBe('queue')
    expect(f.socket.close).not.toHaveBeenCalled()
  })
  it('does not start another connection if the legacy extension is already loaded', () => {
    const f = setup({ legacyLoaded: true })
    expect(f.sockets).toHaveLength(0)
    expect(f.intervals).toHaveLength(0)
  })
})

describe('bridge recovery without page timers',()=>{
 it('immediately reconnects an established socket after abnormal closure',()=>{
  const f=setup()
  f.socket.onmessage({data:JSON.stringify({type:'config',enabled:false,requestSnapshots:true})})
  f.socket.close()
  expect(f.sockets).toHaveLength(2)
  expect(f.timeouts.filter(timer=>timer.delay===3000)).toHaveLength(0)
  const replacement=f.sockets[1]
  replacement.onmessage({data:JSON.stringify({type:'config',enabled:false,requestSnapshots:true})})
  expect(f.sent.filter(packet=>packet.type==='playback').at(-1)).toMatchObject({title:'Title',artists:['First','Second']})
  expect(f.fetcher).not.toHaveBeenCalled()
 })
 it('responds to refresh messages without running its interval and avoids duplicate interval snapshots',()=>{
  const f=setup()
  f.socket.onmessage({data:JSON.stringify({type:'config',enabled:false,requestSnapshots:true})})
  const count=f.sent.length
  f.intervals[0]()
  expect(f.sent).toHaveLength(count)
  f.socket.onmessage({data:JSON.stringify({type:'refresh'})})
  expect(f.sent).toHaveLength(count+2)
  expect(f.sent.at(-2)).toMatchObject({type:'playback',title:'Title',artists:['First','Second']})
  expect(f.fetcher).not.toHaveBeenCalled()
 })
 it('bounds a connection without config and resumes immediately on a focus/online event',()=>{
  const f=setup()
  f.timeouts.find(timer=>timer.delay===8000)!.cb()
  expect(f.socket.close).toHaveBeenCalled()
  expect(f.timeouts.filter(timer=>timer.delay===3000)).toHaveLength(1)
  f.events.online()
  expect(f.sockets).toHaveLength(2)
  f.sockets[1].onmessage({data:JSON.stringify({type:'config',enabled:false,requestSnapshots:true})})
  const count=f.sent.length
  f.events.focus()
  expect(f.sent).toHaveLength(count+2)
 })
 it('preserves metadata and native timing if public Spotify helpers temporarily fail',()=>{
  const f=setup()
  const origin={_state:{item:{uri:'spotify:track:'+'b'.repeat(22),metadata:{title:'Native current',artist_name:'One','artist_name:1':'Two'}},duration:120000,positionAsOfTimestamp:40000,timestamp:Date.now(),isPaused:true}}
  Object.assign(f.player,{origin})
  f.player.getProgress=()=>{throw Error('loading')};f.player.getDuration=()=>{throw Error('loading')};f.player.isPlaying=()=>{throw Error('loading')}
  f.socket.onmessage({data:JSON.stringify({type:'config',enabled:false,requestSnapshots:true})})
  expect(f.sent.filter(packet=>packet.type==='playback').at(-1)).toMatchObject({title:'Native current',trackId:'b'.repeat(22),artists:['One','Two'],durationMs:120000,positionMs:40000,paused:true})
 })
})

it('falls back to the public snapshot when the native player is temporarily inaccessible',()=>{
 const f=setup()
 Object.defineProperty(f.player,'origin',{get:()=>{throw Error('Native player replaced')}})
 f.socket.onmessage({data:JSON.stringify({type:'config',enabled:false,requestSnapshots:true})})
 expect(f.sent.filter(packet=>packet.type==='playback').at(-1)).toMatchObject({title:'Title',artists:['First','Second']})
})
it('replaces a half-open session on focus when application messages stopped',()=>{
 const now=vi.spyOn(Date,'now').mockReturnValue(1000000)
 try{
  const f=setup()
  f.socket.onmessage({data:JSON.stringify({type:'config',enabled:false,requestSnapshots:true})})
  now.mockReturnValue(1011000)
  f.events.focus()
  expect(f.socket.close).toHaveBeenCalled()
  expect(f.sockets).toHaveLength(2)
  f.sockets[1].onmessage({data:JSON.stringify({type:'config',enabled:false,requestSnapshots:true})})
  expect(f.sent.filter(packet=>packet.type==='playback').at(-1)).toMatchObject({title:'Title'})
 }finally{now.mockRestore()}
})
