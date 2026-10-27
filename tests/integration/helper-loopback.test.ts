/**
 * Real end-to-end capture test.
 *
 * Spawns helper/bin/VibeDeckHelper.exe, starts WASAPI loopback capture of the Windows
 * default output, plays a 4 s WAV (1 kHz + 8 kHz sines) through PowerShell's
 * System.Media.SoundPlayer and verifies that the captured PCM contains both tones.
 *
 * Skipped automatically when not on Windows or when the helper has not been built.
 * Run with:  npx vitest run tests/integration
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FFT, magnitudeToDb } from '../../src/renderer/src/audio/fft'
import {
  FrameParser,
  FrameType,
  decodePcmPayload,
  parseHelperMessage,
  serializeCommand,
  type CaptureMsg,
  type HelperMessage
} from '../../src/shared/protocol'

const HELPER_PATH = fileURLToPath(new URL('../../helper/bin/VibeDeckHelper.exe', import.meta.url))
const CAN_RUN = process.platform === 'win32' && existsSync(HELPER_PATH)

const WAV_SECONDS = 4
const WAV_RATE = 48000
const TONE_A = { hz: 1000, amp: 0.25 }
const TONE_B = { hz: 8000, amp: 0.15 }
const CONTROL_HZ = [2000, 4000, 12000]
const CAPTURE_MS = 3500
const REQUIRED_MARGIN_DB = 15
const MIN_CHUNKS = 30

function writeTestWav(path: string): void {
  const channels = 2
  const frames = WAV_SECONDS * WAV_RATE
  const dataBytes = frames * channels * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(WAV_RATE, 24)
  buf.writeUInt32LE(WAV_RATE * channels * 2, 28)
  buf.writeUInt16LE(channels * 2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  let o = 44
  const fadeFrames = Math.round(WAV_RATE * 0.02)
  for (let i = 0; i < frames; i++) {
    const t = i / WAV_RATE
    let v = TONE_A.amp * Math.sin(2 * Math.PI * TONE_A.hz * t) + TONE_B.amp * Math.sin(2 * Math.PI * TONE_B.hz * t)
    // Short fades avoid clicks at start / end.
    if (i < fadeFrames) v *= i / fadeFrames
    else if (i > frames - fadeFrames) v *= (frames - i) / fadeFrames
    const s = Math.max(-32768, Math.min(32767, Math.round(v * 32767)))
    buf.writeInt16LE(s, o)
    buf.writeInt16LE(s, o + 2)
    o += 4
  }
  writeFileSync(path, buf)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid])
}

interface Analysis {
  fftSize: number
  binHz: number
  toneDb: Record<number, number>
  controlDb: number
  marginDb: Record<number, number>
  analysedSeconds: number
}

/** Peak dB near `hz` (±0.5 % or ±2 bins, whichever is wider). */
function peakDbNear(db: Float32Array, binHz: number, hz: number): number {
  const centre = hz / binHz
  const span = Math.max(2, Math.round(centre * 0.005))
  let best = -Infinity
  for (let k = Math.max(1, Math.round(centre - span)); k <= Math.min(db.length - 1, Math.round(centre + span)); k++) {
    if (db[k] > best) best = db[k]
  }
  return best
}

function analyse(mono: Float32Array, sampleRate: number): Analysis {
  let fftSize = 1024
  while (fftSize * 2 <= mono.length && fftSize * 2 <= 1 << 18) fftSize *= 2
  const fft = new FFT(fftSize)
  const tail = mono.subarray(mono.length - fftSize)
  const mags = new Float32Array(fftSize / 2)
  fft.magnitudes(tail, mags, true)
  const db = new Float32Array(mags.length)
  for (let k = 0; k < mags.length; k++) db[k] = magnitudeToDb(mags[k])
  const binHz = sampleRate / fftSize

  const toneDb: Record<number, number> = {}
  for (const tone of [TONE_A, TONE_B]) toneDb[tone.hz] = peakDbNear(db, binHz, tone.hz)

  // Control: median of the bins within ±50 Hz of each control frequency.
  const control: number[] = []
  for (const hz of CONTROL_HZ) {
    const k0 = Math.max(1, Math.round((hz - 50) / binHz))
    const k1 = Math.min(db.length - 1, Math.round((hz + 50) / binHz))
    for (let k = k0; k <= k1; k++) control.push(db[k])
  }
  const controlDb = median(control)
  const marginDb: Record<number, number> = {}
  for (const tone of [TONE_A, TONE_B]) marginDb[tone.hz] = toneDb[tone.hz] - controlDb
  return { fftSize, binHz, toneDb, controlDb, marginDb, analysedSeconds: fftSize / sampleRate }
}

describe.skipIf(!CAN_RUN)('helper loopback capture (real WASAPI, default output device)', () => {
  let helper: ChildProcess | null = null
  let player: ChildProcess | null = null
  let wavPath = ''
  let helperExited = false
  let stderrText = ''

  const messages: HelperMessage[] = []
  const listeners = new Set<(m: HelperMessage) => void>()
  let started: CaptureMsg | null = null
  let captureError: CaptureMsg | null = null
  let chunkCount = 0
  let pcmRate = 0
  let pcmChannels = 0
  let totalFrames = 0
  const monoChunks: Float32Array[] = []
  let analysis: Analysis | null = null
  let setupError: string | null = null

  function waitFor(pred: (m: HelperMessage) => boolean, timeoutMs: number, what: string): Promise<HelperMessage> {
    const existing = messages.find(pred)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener)
        reject(new Error(`Timed out waiting for ${what} (stderr: ${stderrText.slice(0, 500) || 'empty'})`))
      }, timeoutMs)
      const listener = (m: HelperMessage): void => {
        if (!pred(m)) return
        clearTimeout(timer)
        listeners.delete(listener)
        resolve(m)
      }
      listeners.add(listener)
      if (helperExited) {
        clearTimeout(timer)
        listeners.delete(listener)
        reject(new Error(`Helper exited before ${what}`))
      }
    })
  }

  function send(cmd: Parameters<typeof serializeCommand>[0]): void {
    if (helper?.stdin && !helper.stdin.destroyed) helper.stdin.write(serializeCommand(cmd))
  }

  beforeAll(async () => {
    try {
      wavPath = join(tmpdir(), `vibedeck-loopback-${process.pid}-${Date.now()}.wav`)
      writeTestWav(wavPath)

      helper = spawn(HELPER_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      helper.on('exit', () => {
        helperExited = true
      })
      helper.on('error', (err) => {
        stderrText += `spawn error: ${err.message}\n`
        helperExited = true
      })
      helper.stderr?.on('data', (d: Buffer) => {
        stderrText += d.toString('utf8')
      })

      const parser = new FrameParser((type, _flags, payload) => {
        if (type === FrameType.Json) {
          const msg = parseHelperMessage(payload)
          if (!msg) return
          messages.push(msg)
          if (msg.type === 'capture') {
            if (msg.state === 'started' && !started) started = msg
            if (msg.state === 'error') captureError = msg
          }
          for (const l of [...listeners]) l(msg)
        } else if (type === FrameType.Pcm) {
          const pcm = decodePcmPayload(payload)
          if (!pcm) return
          chunkCount++
          pcmRate = pcm.sampleRate
          pcmChannels = pcm.channels
          totalFrames += pcm.frames
          const mono = new Float32Array(pcm.frames)
          const ch = pcm.channels
          const s = pcm.samples
          if (ch === 1) mono.set(s.subarray(0, pcm.frames))
          else for (let i = 0; i < pcm.frames; i++) mono[i] = 0.5 * (s[i * ch] + s[i * ch + 1])
          monoChunks.push(mono)
        }
      })
      helper.stdout?.on('data', (buf: Buffer) => parser.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)))

      await waitFor((m) => m.type === 'hello', 15000, 'hello')
      send({ cmd: 'start', deviceId: null })
      const cap = (await waitFor(
        (m) => m.type === 'capture' && (m.state === 'started' || m.state === 'error'),
        15000,
        'capture started'
      )) as CaptureMsg
      if (cap.state === 'error') {
        throw new Error(`Helper reported capture error ${cap.error?.code ?? 'UNKNOWN'}: ${cap.error?.message ?? ''}`)
      }

      // Play the test tone through the Windows default output (what the helper captures).
      const psPath = wavPath.replace(/'/g, "''")
      player = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer '${psPath}').PlaySync()`], {
        stdio: 'ignore',
        windowsHide: true
      })
      player.on('error', (err) => {
        stderrText += `player error: ${err.message}\n`
      })
      // WASAPI loopback only delivers data while something renders, so start the
      // collection window at the first PCM chunk (bounded wait covers PowerShell start-up).
      const waitStart = Date.now()
      while (chunkCount === 0 && Date.now() - waitStart < 10000 && !helperExited) await sleep(25)
      await sleep(CAPTURE_MS)

      // Analyse the most recent second of captured mono audio.
      if (pcmRate > 0 && totalFrames > 0) {
        const want = Math.min(totalFrames, pcmRate)
        const mono = new Float32Array(want)
        let filled = 0
        for (let i = monoChunks.length - 1; i >= 0 && filled < want; i--) {
          const c = monoChunks[i]
          const take = Math.min(c.length, want - filled)
          mono.set(c.subarray(c.length - take), want - filled - take)
          filled += take
        }
        analysis = analyse(mono, pcmRate)
      }

      const dev = started?.deviceName ?? '(unknown device)'
      console.log(
        [
          '',
          '=== VibeDeck helper loopback report ===',
          `helper:        ${HELPER_PATH}`,
          `device:        ${dev}${started?.followingDefault ? ' (Windows default)' : ''}`,
          `format:        ${started?.sampleRate ?? 0} Hz, ${started?.channels ?? 0} ch (PCM stream: ${pcmRate} Hz, ${pcmChannels} ch)`,
          `pcm chunks:    ${chunkCount} (${totalFrames} frames, ${(totalFrames / Math.max(1, pcmRate)).toFixed(2)} s) in ${CAPTURE_MS} ms`,
          analysis
            ? `analysis:      FFT ${analysis.fftSize} (${analysis.binHz.toFixed(2)} Hz/bin) over the last ${analysis.analysedSeconds.toFixed(2)} s`
            : 'analysis:      (no PCM received)',
          analysis ? `1 kHz:         ${analysis.toneDb[1000].toFixed(1)} dB  (margin ${analysis.marginDb[1000].toFixed(1)} dB)` : '',
          analysis ? `8 kHz:         ${analysis.toneDb[8000].toFixed(1)} dB  (margin ${analysis.marginDb[8000].toFixed(1)} dB)` : '',
          analysis ? `control:       ${analysis.controlDb.toFixed(1)} dB (median of 2 / 4 / 12 kHz bins)` : '',
          `messages:      ${messages.map((m) => m.type).join(', ')}`,
          '======================================='
        ]
          .filter((l) => l !== '')
          .join('\n')
      )
    } catch (err) {
      setupError = err instanceof Error ? err.message : String(err)
      console.log(`helper loopback setup failed: ${setupError}`)
    }
  }, 30000)

  afterAll(async () => {
    try {
      if (player && player.exitCode === null) player.kill()
    } catch {
      /* ignore */
    }
    if (helper) {
      try {
        send({ cmd: 'quit' })
        helper.stdin?.end()
      } catch {
        /* ignore */
      }
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => {
          if (helperExited) resolve(true)
          else helper?.once('exit', () => resolve(true))
        }),
        sleep(2000).then(() => false)
      ])
      if (!exited) {
        try {
          helper.kill()
        } catch {
          /* ignore */
        }
      }
    }
    if (wavPath) {
      try {
        unlinkSync(wavPath)
      } catch {
        /* ignore */
      }
    }
  })

  it('reports a capture "started" message with a valid sample rate', () => {
    expect(setupError, setupError ?? '').toBeNull()
    expect(captureError).toBeNull()
    expect(started).not.toBeNull()
    expect(started!.type).toBe('capture')
    expect(started!.state).toBe('started')
    expect(started!.sampleRate).toBeGreaterThan(0)
    expect(started!.channels).toBeGreaterThan(0)
  })

  it(`delivers at least ${MIN_CHUNKS} PCM chunks while the tone plays`, () => {
    expect(setupError, setupError ?? '').toBeNull()
    expect(chunkCount).toBeGreaterThanOrEqual(MIN_CHUNKS)
    expect(pcmRate).toBeGreaterThan(0)
    expect(pcmChannels).toBeGreaterThan(0)
  })

  it(`shows the 1 kHz and 8 kHz tones at least ${REQUIRED_MARGIN_DB} dB above the control bins`, () => {
    expect(setupError, setupError ?? '').toBeNull()
    expect(analysis).not.toBeNull()
    const a = analysis!
    expect(Number.isFinite(a.toneDb[1000])).toBe(true)
    expect(Number.isFinite(a.toneDb[8000])).toBe(true)
    expect(a.marginDb[1000]).toBeGreaterThanOrEqual(REQUIRED_MARGIN_DB)
    expect(a.marginDb[8000]).toBeGreaterThanOrEqual(REQUIRED_MARGIN_DB)
  })
})
