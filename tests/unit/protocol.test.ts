import { describe, expect, it } from 'vitest'
import {
  FRAME_HEADER_SIZE,
  FRAME_MAGIC,
  FrameParser,
  FrameType,
  MAX_FRAME_SIZE,
  PCM_HEADER_SIZE,
  decodePcmPayload,
  encodeFrame,
  encodeJsonFrame,
  encodePcmFrame,
  encodePcmPayload,
  parseHelperMessage,
  serializeCommand,
  type HelperMessage
} from '../../src/shared/protocol'

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

interface Parsed {
  type: number
  flags: number
  payload: Uint8Array
}

function collect(): { parser: FrameParser; frames: Parsed[] } {
  const frames: Parsed[] = []
  const parser = new FrameParser((type, flags, payload) => frames.push({ type, flags, payload: payload.slice() }))
  return { parser, frames }
}

const hello: HelperMessage = { type: 'hello', version: 1, pid: 4242, helperVersion: '1.0.0', dotnet: '4.0.30319' }
const capture: HelperMessage = {
  type: 'capture',
  state: 'started',
  deviceId: '{0.0.0.00000000}.{abc}',
  deviceName: 'Speakers (Test)',
  sampleRate: 48000,
  channels: 2,
  followingDefault: true
}

function pcmSamples(frames: number, channels: number): Float32Array {
  const s = new Float32Array(frames * channels)
  for (let i = 0; i < s.length; i++) s[i] = Math.sin(i * 0.01) * (i % 2 ? 0.5 : -0.25)
  return s
}

const samples = pcmSamples(256, 2)
const framesToSend: Uint8Array[] = [
  encodeJsonFrame(hello),
  encodePcmFrame(48000, 2, samples),
  encodeJsonFrame(capture),
  encodeFrame(FrameType.Json, new Uint8Array(0), 7), // empty payload with flags
  encodePcmFrame(44100, 1, pcmSamples(100, 1))
]
const stream = concat(framesToSend)

function expectFramesMatch(frames: Parsed[]): void {
  expect(frames.length).toBe(framesToSend.length)
  for (let i = 0; i < frames.length; i++) {
    const src = framesToSend[i]
    expect(frames[i].type).toBe(src[4])
    expect(frames[i].flags).toBe(src[5])
    expect(frames[i].payload).toEqual(src.subarray(FRAME_HEADER_SIZE))
  }
  expect(parseHelperMessage(frames[0].payload)).toEqual(hello)
  expect(parseHelperMessage(frames[2].payload)).toEqual(capture)
  const pcm = decodePcmPayload(frames[1].payload)
  expect(pcm).not.toBeNull()
  expect(pcm!.samples).toEqual(samples)
}

describe('FrameParser', () => {
  it('parses a whole stream in one push', () => {
    const { parser, frames } = collect()
    parser.push(stream)
    expectFramesMatch(frames)
    expect(parser.droppedBytes).toBe(0)
    expect(parser.framesParsed).toBe(framesToSend.length)
  })

  it('reassembles frames split at every single byte', () => {
    const { parser, frames } = collect()
    for (let i = 0; i < stream.length; i++) parser.push(stream.subarray(i, i + 1))
    expectFramesMatch(frames)
    expect(parser.droppedBytes).toBe(0)
  })

  it('reassembles frames split at random boundaries (many seeds)', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const random = rng(seed)
      const { parser, frames } = collect()
      let o = 0
      while (o < stream.length) {
        const n = 1 + Math.floor(random() * 300)
        parser.push(stream.subarray(o, Math.min(stream.length, o + n)))
        o += n
      }
      expectFramesMatch(frames)
    }
  })

  it('handles chunks that end exactly on a header boundary', () => {
    const { parser, frames } = collect()
    const first = framesToSend[0]
    parser.push(first.subarray(0, FRAME_HEADER_SIZE))
    expect(frames.length).toBe(0)
    parser.push(first.subarray(FRAME_HEADER_SIZE))
    expect(frames.length).toBe(1)
    parser.push(stream.subarray(first.length))
    expectFramesMatch(frames)
  })

  it('resynchronises after leading and interleaved garbage', () => {
    const random = rng(99)
    const garbage = (n: number): Uint8Array => {
      const g = new Uint8Array(n)
      // Avoid accidentally producing the 'V' of the magic so the count is exact.
      for (let i = 0; i < n; i++) g[i] = Math.floor(random() * 0x40)
      return g
    }
    const g1 = garbage(17)
    const g2 = garbage(5)
    const g3 = garbage(300)
    const noisy = concat([g1, framesToSend[0], g2, framesToSend[1], framesToSend[2], g3, framesToSend[3], framesToSend[4]])
    const { parser, frames } = collect()
    for (let o = 0; o < noisy.length; o += 37) parser.push(noisy.subarray(o, Math.min(noisy.length, o + 37)))
    expectFramesMatch(frames)
    expect(parser.droppedBytes).toBe(g1.length + g2.length + g3.length)
  })

  it('skips a corrupt header with an absurd length and recovers the next frame', () => {
    const bogus = new Uint8Array(FRAME_HEADER_SIZE)
    bogus.set(FRAME_MAGIC, 0)
    bogus[4] = FrameType.Json
    new DataView(bogus.buffer).setUint32(8, MAX_FRAME_SIZE + 1, true)
    const { parser, frames } = collect()
    parser.push(concat([bogus, framesToSend[0]]))
    expect(frames.length).toBe(1)
    expect(parseHelperMessage(frames[0].payload)).toEqual(hello)
    expect(parser.droppedBytes).toBe(FRAME_HEADER_SIZE)
  })

  it('never lets a handler exception break the stream', () => {
    let calls = 0
    const parser = new FrameParser(() => {
      calls++
      throw new Error('boom')
    })
    expect(() => parser.push(stream)).not.toThrow()
    expect(calls).toBe(framesToSend.length)
  })

  it('reset() discards buffered partial data', () => {
    const { parser, frames } = collect()
    parser.push(framesToSend[1].subarray(0, 40))
    parser.reset()
    parser.push(framesToSend[0])
    expect(frames.length).toBe(1)
    expect(frames[0].type).toBe(FrameType.Json)
  })
})

describe('PCM payload', () => {
  it('round-trips encodePcmPayload -> decodePcmPayload exactly', () => {
    const payload = encodePcmPayload(48000, 2, samples)
    expect(payload.length).toBe(PCM_HEADER_SIZE + samples.length * 4)
    const decoded = decodePcmPayload(payload)
    expect(decoded).not.toBeNull()
    expect(decoded!.sampleRate).toBe(48000)
    expect(decoded!.channels).toBe(2)
    expect(decoded!.frames).toBe(256)
    expect(decoded!.samples.length).toBe(samples.length)
    expect(decoded!.samples).toEqual(samples)
    // The decoded array is a fresh, aligned copy.
    expect(decoded!.samples.byteOffset).toBe(0)
    expect(decoded!.samples.buffer).not.toBe(payload.buffer)
  })

  it('decodes from an unaligned view into a larger buffer', () => {
    const payload = encodePcmPayload(44100, 1, pcmSamples(33, 1))
    const shifted = new Uint8Array(payload.length + 3)
    shifted.set(payload, 3)
    const decoded = decodePcmPayload(shifted.subarray(3))
    expect(decoded).not.toBeNull()
    expect(decoded!.frames).toBe(33)
    expect(decoded!.samples).toEqual(pcmSamples(33, 1))
  })

  it('floors partial frames when the sample count is not a multiple of channels', () => {
    const payload = encodePcmPayload(48000, 2, new Float32Array(7))
    expect(decodePcmPayload(payload)!.frames).toBe(3)
  })

  it('rejects malformed payloads', () => {
    const good = encodePcmPayload(48000, 2, samples)
    expect(decodePcmPayload(good.subarray(0, PCM_HEADER_SIZE - 1))).toBeNull()
    const badFormat = good.slice()
    new DataView(badFormat.buffer).setUint16(6, 2, true)
    expect(decodePcmPayload(badFormat)).toBeNull()
    const badChannels = good.slice()
    new DataView(badChannels.buffer).setUint16(4, 0, true)
    expect(decodePcmPayload(badChannels)).toBeNull()
    const badRate = good.slice()
    new DataView(badRate.buffer).setUint32(0, 1000, true)
    expect(decodePcmPayload(badRate)).toBeNull()
    const truncated = good.subarray(0, good.length - 8)
    expect(decodePcmPayload(truncated)).toBeNull()
  })
})

describe('JSON helpers', () => {
  it('parseHelperMessage rejects non-objects and messages without a type', () => {
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
    expect(parseHelperMessage(enc('{"type":"pong","time":1}'))).toEqual({ type: 'pong', time: 1 })
    expect(parseHelperMessage(enc('[1,2]'))).toBeNull()
    expect(parseHelperMessage(enc('{"time":1}'))).toBeNull()
    expect(parseHelperMessage(enc('not json'))).toBeNull()
    expect(parseHelperMessage(new Uint8Array([0xff, 0xfe]))).toBeNull()
  })

  it('serializeCommand emits one JSON object per line', () => {
    expect(serializeCommand({ cmd: 'start', deviceId: null })).toBe('{"cmd":"start","deviceId":null}\n')
    expect(serializeCommand({ cmd: 'quit' })).toBe('{"cmd":"quit"}\n')
  })
})
