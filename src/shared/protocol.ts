/**
 * Wire protocol between the Electron main process and the native Windows helper
 * (helper/src/*.cs -> VibeDeckHelper.exe).
 *
 * helper -> main (stdout, binary frames):
 *   +--------+------+-------+----------+------------+---------+
 *   | magic  | type | flags | reserved | length     | payload |
 *   | 'VDKP' | u8   | u8    | u16 LE   | u32 LE     | bytes   |
 *   +--------+------+-------+----------+------------+---------+
 *   type 1 = JSON (UTF-8) message, see HelperMessage
 *   type 2 = PCM payload:
 *       sampleRate u32 LE | channels u16 LE | format u16 LE (1 = float32) |
 *       frames u32 LE     | reserved u32 LE | float32 LE interleaved samples
 *
 * main -> helper (stdin): one JSON object per line, see HelperCommand.
 */

export const FRAME_MAGIC = [0x56, 0x44, 0x4b, 0x50] as const // 'V' 'D' 'K' 'P'
export const FRAME_HEADER_SIZE = 12
export const PCM_HEADER_SIZE = 16
export const MAX_FRAME_SIZE = 16 * 1024 * 1024
export const PROTOCOL_VERSION = 1

export const FrameType = {
  Json: 1,
  Pcm: 2
} as const
export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType]

// ---------------------------------------------------------------------------
// JSON messages (helper -> main)
// ---------------------------------------------------------------------------

export interface HelperDevice {
  id: string
  name: string
  isDefault: boolean
  sampleRate: number
  channels: number
}

export interface HelloMsg {
  type: 'hello'
  version: number
  pid: number
  helperVersion: string
  dotnet: string
}

export interface DevicesMsg {
  type: 'devices'
  devices: HelperDevice[]
  defaultId: string | null
}

export interface CaptureMsg {
  type: 'capture'
  state: 'started' | 'stopped' | 'error' | 'restarting'
  deviceId: string | null
  deviceName: string | null
  sampleRate: number
  channels: number
  /** True if the helper is following the Windows default device. */
  followingDefault: boolean
  error?: { code: string; message: string; detail?: string }
}

export interface TrackMsg {
  type: 'track'
  available: boolean
  title: string
  artist: string
  album: string
  sourceApp: string
  status: 'playing' | 'paused' | 'stopped' | 'changing' | 'opening' | 'closed' | 'unknown'
  positionMs: number
  durationMs: number
  /** Epoch ms when the position was sampled. */
  positionUpdatedAt: number
  /** SHA1 hex of the artwork bytes, null when none. */
  artworkKey: string | null
}

export interface ArtworkMsg {
  type: 'artwork'
  key: string
  contentType: string
  /** base64-encoded image bytes */
  base64: string
}

export interface LogMsg {
  type: 'log'
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
}

export interface DeviceChangeMsg {
  type: 'deviceChange'
  kind: 'added' | 'removed' | 'defaultChanged' | 'stateChanged'
  deviceId: string | null
}

export interface PongMsg {
  type: 'pong'
  time: number
}

export interface ErrorMsg {
  type: 'error'
  code: string
  message: string
  detail?: string
}

export type HelperMessage = HelloMsg | DevicesMsg | CaptureMsg | TrackMsg | ArtworkMsg | LogMsg | DeviceChangeMsg | PongMsg | ErrorMsg

// ---------------------------------------------------------------------------
// Commands (main -> helper)
// ---------------------------------------------------------------------------

export type HelperCommand =
  | { cmd: 'listDevices' }
  | { cmd: 'start'; deviceId: string | null }
  | { cmd: 'stop' }
  | { cmd: 'ping' }
  | { cmd: 'getTrack' }
  | { cmd: 'requestArtwork'; key: string }
  | { cmd: 'quit' }

// ---------------------------------------------------------------------------
// Frame encoding / decoding (shared by main process and tests)
// ---------------------------------------------------------------------------

export interface DecodedPcm {
  sampleRate: number
  channels: number
  frames: number
  samples: Float32Array
}

export function encodeFrame(type: FrameTypeValue, payload: Uint8Array, flags = 0): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_SIZE + payload.length)
  out[0] = FRAME_MAGIC[0]
  out[1] = FRAME_MAGIC[1]
  out[2] = FRAME_MAGIC[2]
  out[3] = FRAME_MAGIC[3]
  out[4] = type
  out[5] = flags & 0xff
  out[6] = 0
  out[7] = 0
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(8, payload.length, true)
  out.set(payload, FRAME_HEADER_SIZE)
  return out
}

export function encodeJsonFrame(msg: HelperMessage): Uint8Array {
  return encodeFrame(FrameType.Json, new TextEncoder().encode(JSON.stringify(msg)))
}

export function encodePcmPayload(sampleRate: number, channels: number, samples: Float32Array): Uint8Array {
  const frames = Math.floor(samples.length / channels)
  const out = new Uint8Array(PCM_HEADER_SIZE + frames * channels * 4)
  const view = new DataView(out.buffer)
  view.setUint32(0, sampleRate, true)
  view.setUint16(4, channels, true)
  view.setUint16(6, 1, true)
  view.setUint32(8, frames, true)
  view.setUint32(12, 0, true)
  for (let i = 0; i < frames * channels; i++) view.setFloat32(PCM_HEADER_SIZE + i * 4, samples[i], true)
  return out
}

export function encodePcmFrame(sampleRate: number, channels: number, samples: Float32Array): Uint8Array {
  return encodeFrame(FrameType.Pcm, encodePcmPayload(sampleRate, channels, samples))
}

/**
 * Decode a PCM payload. Always returns a properly aligned Float32Array copy so the
 * result can be handed across IPC or into typed-array math without alignment issues.
 */
export function decodePcmPayload(payload: Uint8Array): DecodedPcm | null {
  if (payload.length < PCM_HEADER_SIZE) return null
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const sampleRate = view.getUint32(0, true)
  const channels = view.getUint16(4, true)
  const format = view.getUint16(6, true)
  const frames = view.getUint32(8, true)
  if (format !== 1 || channels < 1 || channels > 32 || sampleRate < 8000 || sampleRate > 384000) return null
  const count = frames * channels
  if (PCM_HEADER_SIZE + count * 4 > payload.length) return null
  const samples = new Float32Array(count)
  const bytes = new Uint8Array(samples.buffer)
  bytes.set(payload.subarray(PCM_HEADER_SIZE, PCM_HEADER_SIZE + count * 4))
  // The helper always writes little-endian floats; JS typed arrays use the platform
  // endianness which is little-endian on every platform Electron runs on.
  return { sampleRate, channels, frames, samples }
}

export type FrameHandler = (type: number, flags: number, payload: Uint8Array) => void

/**
 * Incremental frame parser for the helper's stdout stream.
 * Handles partial frames and resynchronises on corrupted data by scanning for the magic.
 */
export class FrameParser {
  private buffer: Uint8Array = new Uint8Array(0)
  public droppedBytes = 0
  public framesParsed = 0

  constructor(private readonly onFrame: FrameHandler) {}

  push(chunk: Uint8Array): void {
    if (this.buffer.length === 0) {
      this.buffer = chunk
    } else {
      const merged = new Uint8Array(this.buffer.length + chunk.length)
      merged.set(this.buffer, 0)
      merged.set(chunk, this.buffer.length)
      this.buffer = merged
    }
    this.drain()
  }

  reset(): void {
    this.buffer = new Uint8Array(0)
  }

  private drain(): void {
    let offset = 0
    const buf = this.buffer
    while (buf.length - offset >= FRAME_HEADER_SIZE) {
      if (
        buf[offset] !== FRAME_MAGIC[0] ||
        buf[offset + 1] !== FRAME_MAGIC[1] ||
        buf[offset + 2] !== FRAME_MAGIC[2] ||
        buf[offset + 3] !== FRAME_MAGIC[3]
      ) {
        // resync: skip one byte and try again
        offset++
        this.droppedBytes++
        continue
      }
      const view = new DataView(buf.buffer, buf.byteOffset + offset, FRAME_HEADER_SIZE)
      const type = view.getUint8(4)
      const flags = view.getUint8(5)
      const length = view.getUint32(8, true)
      if (length > MAX_FRAME_SIZE) {
        // corrupt header; skip magic and resync
        offset += 4
        this.droppedBytes += 4
        continue
      }
      if (buf.length - offset - FRAME_HEADER_SIZE < length) break // wait for more data
      const payload = buf.subarray(offset + FRAME_HEADER_SIZE, offset + FRAME_HEADER_SIZE + length)
      offset += FRAME_HEADER_SIZE + length
      this.framesParsed++
      try {
        this.onFrame(type, flags, payload)
      } catch {
        // never let a handler error break the stream
      }
    }
    this.buffer = offset === 0 ? buf : buf.slice(offset)
  }
}

export function parseHelperMessage(payload: Uint8Array): HelperMessage | null {
  try {
    const text = new TextDecoder('utf-8').decode(payload)
    const obj = JSON.parse(text) as unknown
    if (typeof obj !== 'object' || obj === null || typeof (obj as { type?: unknown }).type !== 'string') return null
    return obj as HelperMessage
  } catch {
    return null
  }
}

export function serializeCommand(cmd: HelperCommand): string {
  return JSON.stringify(cmd) + '\n'
}
