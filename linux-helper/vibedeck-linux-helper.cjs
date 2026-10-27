#!/usr/bin/env node
'use strict'

const { spawn, spawnSync } = require('node:child_process')
const readline = require('node:readline')

const RATE = 48000
const CHANNELS = 2
let capture = null
let remainder = Buffer.alloc(0)

function frame(type, payload) {
  const header = Buffer.allocUnsafe(12)
  header.write('VDKP', 0, 4, 'ascii')
  header[4] = type
  header[5] = 0
  header.writeUInt16LE(0, 6)
  header.writeUInt32LE(payload.length, 8)
  const ready = process.stdout.write(Buffer.concat([header, payload]))
  if (!ready && capture?.stdout) {
    capture.stdout.pause()
    process.stdout.once('drain', () => capture?.stdout?.resume())
  }
}

function json(message) {
  frame(1, Buffer.from(JSON.stringify(message), 'utf8'))
}

function command(name, args = []) {
  return spawnSync(name, args, { encoding: 'utf8', windowsHide: true })
}

function defaultSink() {
  const direct = command('pactl', ['get-default-sink'])
  if (direct.status === 0 && direct.stdout.trim()) return direct.stdout.trim()
  const info = command('pactl', ['info'])
  const match = info.status === 0 ? /^Default Sink:\s*(.+)$/mi.exec(info.stdout) : null
  return match ? match[1].trim() : ''
}

function devices() {
  const preferred = defaultSink()
  const result = command('pactl', ['list', 'short', 'sinks'])
  if (result.status !== 0) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({ id: parts[1], name: parts[1], isDefault: parts[1] === preferred, sampleRate: RATE, channels: CHANNELS }))
}

function stopCapture(announce = true) {
  if (capture) {
    capture.removeAllListeners()
    capture.kill('SIGTERM')
    capture = null
  }
  remainder = Buffer.alloc(0)
  if (announce) json({ type: 'capture', state: 'stopped', deviceId: null, deviceName: null, sampleRate: 0, channels: 0, followingDefault: true })
}

function startCapture(requested) {
  stopCapture(false)
  const sink = typeof requested === 'string' && requested ? requested : defaultSink()
  if (!sink) {
    json({ type: 'capture', state: 'error', deviceId: null, deviceName: null, sampleRate: 0, channels: 0, followingDefault: !requested, error: { code: 'NO_AUDIO_DEVICE', message: 'No PulseAudio or PipeWire output was found.' } })
    return
  }
  const monitor = sink.endsWith('.monitor') ? sink : `${sink}.monitor`
  const child = spawn('parec', [`--device=${monitor}`, '--format=float32le', `--rate=${RATE}`, `--channels=${CHANNELS}`, '--latency-msec=25'], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  capture = child
  child.once('spawn', () => json({ type: 'capture', state: 'started', deviceId: sink, deviceName: sink, sampleRate: RATE, channels: CHANNELS, followingDefault: !requested }))
  child.stdout.on('data', (chunk) => {
    const data = remainder.length ? Buffer.concat([remainder, chunk]) : chunk
    const usable = data.length - (data.length % (CHANNELS * 4))
    remainder = usable < data.length ? data.subarray(usable) : Buffer.alloc(0)
    if (!usable) return
    const pcm = Buffer.allocUnsafe(16 + usable)
    pcm.writeUInt32LE(RATE, 0)
    pcm.writeUInt16LE(CHANNELS, 4)
    pcm.writeUInt16LE(1, 6)
    pcm.writeUInt32LE(usable / (CHANNELS * 4), 8)
    pcm.writeUInt32LE(0, 12)
    data.copy(pcm, 16, 0, usable)
    frame(2, pcm)
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000) })
  child.once('error', (error) => {
    if (capture !== child) return
    capture = null
    json({ type: 'capture', state: 'error', deviceId: sink, deviceName: sink, sampleRate: 0, channels: 0, followingDefault: !requested, error: { code: 'CAPTURE_INIT_FAILED', message: 'Linux audio capture could not start.', detail: error.message } })
  })
  child.once('exit', (code) => {
    if (capture !== child) return
    capture = null
    json({ type: 'capture', state: 'error', deviceId: sink, deviceName: sink, sampleRate: 0, channels: 0, followingDefault: !requested, error: { code: 'DEVICE_DISCONNECTED', message: 'Linux audio capture stopped.', detail: `parec exited with ${code}: ${stderr}` } })
  })
}

function handle(message) {
  switch (message?.cmd) {
    case 'ping': json({ type: 'pong', time: Date.now() }); break
    case 'listDevices': {
      const list = devices()
      json({ type: 'devices', devices: list, defaultId: list.find((device) => device.isDefault)?.id || null })
      break
    }
    case 'start': startCapture(message.deviceId); break
    case 'stop': stopCapture(); break
    case 'getTrack': json({ type: 'track', available: false, title: '', artist: '', album: '', sourceApp: '', status: 'unknown', positionMs: 0, durationMs: 0, positionUpdatedAt: Date.now(), artworkKey: null }); break
    case 'requestArtwork': break
    case 'quit': stopCapture(false); process.exit(0); break
  }
}

process.on('SIGTERM', () => { stopCapture(false); process.exit(0) })
process.on('SIGINT', () => { stopCapture(false); process.exit(0) })
readline.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  try { handle(JSON.parse(line)) } catch { json({ type: 'log', level: 'warn', message: 'Ignored malformed command.' }) }
})

json({ type: 'hello', version: 1, pid: process.pid, helperVersion: '1.0.0-linux', dotnet: `Node ${process.version}` })
