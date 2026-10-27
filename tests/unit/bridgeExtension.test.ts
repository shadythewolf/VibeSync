import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parseBridgePlayback, parseBridgeQueue } from '../../src/main/bridgePlayback'

const script = readFileSync('spicetify/vibesync-bridge.js','utf8')
describe('Spicetify local playback extension', () => {
  it('sends all artists, artwork, pause and seek without network requests when lyrics are disabled', async () => {
    const packets: any[] = [], events: Record<string, () => void> = {}
    let tick = () => {}, socket: any
    const fetcher = vi.fn()
    const player = {data:{item:{uri:'spotify:track:'+'a'.repeat(22),metadata:{title:'Local song',album_title:'Album',artist_name:'First','artist_name:2':'Third','artist_name:1':'Second',image_xlarge_url:'spotify:image:abc'}}},
      getDuration:()=>120000,getProgress:()=>42000,isPlaying:()=>true,addEventListener:(event:string,fn:()=>void)=>{events[event]=fn}}
    class Socket {
      static OPEN=1;static CONNECTING=0;readyState=1;onmessage: any;onclose: any
      constructor() {socket=this}
      send(raw:string) {packets.push(JSON.parse(raw))}
      close() {this.onclose?.()}
    }
    await runInNewContext(script,{Spicetify:{Player:player,Platform:{}},WebSocket:Socket,fetch:fetcher,
      setInterval:(fn:()=>void)=>{tick=fn},setTimeout:vi.fn(),console})
    socket.onmessage({data:JSON.stringify({type:'config',enabled:false})})
    const packet=packets.find(packet=>packet.type==='playback')
    expect(packet).toMatchObject({title:'Local song',artists:['First','Second','Third'],positionMs:42000,paused:false,artworkUrl:'https://i.scdn.co/image/abc'})
    player.getProgress=()=>90000;player.isPlaying=()=>false
    events.onplaypause()
    expect(packets.at(-1)).toMatchObject({type:'playback',paused:true,positionMs:90000})
    tick();tick()
    expect(fetcher).not.toHaveBeenCalled()
    expect(packets.filter(p=>p.type==='lyrics')).toHaveLength(1)
    expect(parseBridgePlayback(packet)).toMatchObject({title:'Local song',artist:'First, Second, Third'})
  })
  it('rejects untrusted artwork URLs and clamps malformed timing', () => {
    const base={type:'playback',available:true,trackId:'a'.repeat(22),title:'Song',artists:['One','One','Two'],paused:true,durationMs:1000,positionMs:90000,artworkUrl:'file:///etc/passwd'}
    expect(parseBridgePlayback(base)).toMatchObject({artworkUrl:null,artist:'One, Two',positionMs:1000,status:'paused'})
    expect(parseBridgePlayback({...base,trackId:'bad'})).toBeUndefined()
    expect(parseBridgePlayback({type:'playback',available:false})).toBeNull()
  })
})

function queueFixture() {
  const packets:any[]=[],events:Record<string,()=>void>={};let tick=()=>{},socket:any
  const current={uri:'spotify:track:'+'a'.repeat(22),metadata:{title:'Current',artist_name:'Current artist'}}
  const first={uri:'spotify:track:'+'b'.repeat(22),metadata:{title:'Next',artist_name:'First','artist_name:1':'Second','artist_name2':'Third',album_title:'Album',image_url:'spotify:image:cover'}}
  const spicetify:any={Queue:{track:current,nextTracks:[first]},Player:{data:{item:current},getDuration:()=>120000,getProgress:()=>1000,isPlaying:()=>true,addEventListener:(key:string,fn:()=>void)=>{events[key]=fn}},Platform:{}}
  class Socket{static OPEN=1;static CONNECTING=0;readyState=1;onmessage:any;constructor(){socket=this}send(raw:string){packets.push(JSON.parse(raw))}}
  const fetcher=vi.fn()
  runInNewContext(script,{Spicetify:spicetify,WebSocket:Socket,fetch:fetcher,setInterval:(fn:()=>void)=>{tick=fn},setTimeout:vi.fn(),console})
  socket.onmessage({data:JSON.stringify({type:'config',enabled:false})})
  return {spicetify,first,packets,fetcher,tick:()=>tick(),events,latest:()=>packets.filter(packet=>packet.type==='queue').at(-1)}
}
describe('Spicetify local queue extension',()=>{
 it('reads next songs with all artist formats and follows reordering without any network calls',()=>{
  const f=queueFixture()
  expect(f.latest()).toMatchObject({type:'queue',available:true,trackId:'a'.repeat(22),nextTrack:{title:'Next',artists:['First','Second','Third'],artworkUrl:'https://i.scdn.co/image/cover'}})
  f.spicetify.Queue.nextTracks=[{...f.first,metadata:{title:'Reordered',artist_name:'Artist'}}];f.tick()
  expect(f.latest().nextTrack.title).toBe('Reordered')
  expect(f.fetcher).not.toHaveBeenCalled()
  expect(parseBridgeQueue(f.latest())).toMatchObject({nextTrack:{title:'Reordered',artist:'Artist'}})
 })
 it('supports wrapped ProvidedTracks and known empty queues',()=>{
  const f=queueFixture();f.spicetify.Queue.nextTracks=[{contextTrack:f.first}];f.tick()
  expect(f.latest().nextTrack.title).toBe('Next')
  f.spicetify.Queue.nextTracks=[];f.tick()
  expect(f.latest()).toMatchObject({available:true,nextTrack:null})
 })
 it('hides missing metadata, stale queues and next episodes without skipping ahead',()=>{
  const f=queueFixture();f.spicetify.Queue.track={uri:'spotify:track:'+'c'.repeat(22)};f.tick()
  expect(f.latest().available).toBe(false)
  f.spicetify.Queue.track=f.spicetify.Player.data.item
  f.spicetify.Queue.nextTracks=[{uri:'spotify:track:'+'b'.repeat(22)}];f.tick()
  expect(f.latest().available).toBe(false)
  f.spicetify.Queue.nextTracks=[{uri:'spotify:episode:'+'d'.repeat(22),metadata:{title:'Episode'}},f.first];f.tick()
  expect(f.latest()).toMatchObject({available:true,nextTrack:null})
 })
 it('follows song changes with a matching new queue',()=>{
  const f=queueFixture();f.spicetify.Player.data.item=f.first;f.spicetify.Queue={track:f.first,nextTracks:[]}
  f.events.songchange()
  expect(f.latest()).toMatchObject({trackId:'b'.repeat(22),nextTrack:null})
 })
 it('rejects malformed queue payloads and supports local-file playback IDs',()=>{
  expect(parseBridgeQueue({type:'queue',available:true,trackId:'bad',nextTrack:null})).toBeUndefined()
  expect(parseBridgeQueue({type:'queue',available:false})).toBeNull()
  expect(parseBridgePlayback({type:'playback',available:true,uri:'spotify:local:Artist:Album:Title:120',title:'Title',artists:['Artist'],paused:false,positionMs:1000,durationMs:120000})).toMatchObject({title:'Title',trackId:'spotify:local:Artist:Album:Title:120'})
 })
})

it('connects and identifies the bridge even before Spotify has a loaded song',()=>{
 let socket:any
 const packets:any[]=[]
 class Socket{static OPEN=1;static CONNECTING=0;readyState=1;onmessage:any;constructor(){socket=this}send(raw:string){packets.push(JSON.parse(raw))}}
 runInNewContext(script,{Spicetify:{Player:{data:null,addEventListener:()=>{}},Platform:{}},WebSocket:Socket,setTimeout:vi.fn(),setInterval:vi.fn(),console})
 socket.onmessage({data:JSON.stringify({type:'config',enabled:false})})
 expect(packets).toContainEqual({type:'hello',version:'2.0.1',capabilities:['playback','queue','lyrics','refresh']})
 expect(packets).toContainEqual({type:'playback',available:false})
 expect(packets).toContainEqual({type:'queue',available:false})
})
