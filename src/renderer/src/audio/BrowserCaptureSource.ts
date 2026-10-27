/**
 * Chromium system-audio loopback fallback.
 *
 * `getDisplayMedia({ video: true, audio: true })` is answered by the main process'
 * display-media handler with `audio: 'loopback'` (real WASAPI loopback of the default
 * output device, Windows only). The video track is stopped immediately; the audio track
 * feeds an AudioContext whose worklet (or ScriptProcessorNode fallback) batches PCM and
 * pushes it into the AudioEngine. The microphone is never requested.
 *
 * State is reported to the main process through window.vibedeck.audio.reportBrowserCapture
 * so the AudioStatus the UI shows stays owned by main.
 */
import type { AppError, BrowserCaptureReport, ErrorCode } from '@shared/types'
import type { IAudioEngine } from './types'
import pcmWorkletSource from './pcm-worklet.js?raw'

const WORKLET_NAME = 'vibedeck-pcm-capture'
const SCRIPT_PROCESSOR_FRAMES = 2048
const RESTART_DELAY_MS = 1000
const CHANNELS = 2

interface WorkletBatch {
  sampleRate?: number
  channels?: number
  frames?: number
  buffer?: ArrayBuffer
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function makeError(code: ErrorCode, message: string, hint?: string, detail?: string): AppError {
  const e: AppError = { code, message }
  if (hint) e.hint = hint
  if (detail) e.detail = detail
  return e
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}

function report(r: BrowserCaptureReport): void {
  try {
    if (typeof window !== 'undefined' && window.vibedeck) window.vibedeck.audio.reportBrowserCapture(r)
  } catch {
    /* main process unavailable (plain browser dev) */
  }
}

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string, detail?: string): void {
  try {
    if (typeof window !== 'undefined' && window.vibedeck) {
      window.vibedeck.app.log(level, message, detail)
      return
    }
  } catch {
    /* fall through */
  }
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info
  fn(`[BrowserCapture] ${message}`, detail ?? '')
}

export class BrowserCaptureError extends Error {
  readonly appError: AppError
  constructor(appError: AppError) {
    super(appError.message)
    this.name = 'BrowserCaptureError'
    this.appError = appError
  }
}

interface Session {
  stream: MediaStream
  track: MediaStreamTrack
  ctx: AudioContext
  source: MediaStreamAudioSourceNode
  worklet: AudioWorkletNode | null
  processor: ScriptProcessorNode | null
  mute: GainNode
  onEnded: () => void
  /** Reused interleave buffer for the ScriptProcessor path. */
  scratch: Float32Array | null
}

export class BrowserCaptureSource {
  private readonly engine: IAudioEngine
  private session: Session | null = null
  private starting: Promise<void> | null = null
  private stopping = false
  private restartBudget = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null

  constructor(engine: IAudioEngine) {
    this.engine = engine
  }

  get active(): boolean {
    return this.session !== null
  }

  /** Start (or restart) capture. Rejects with a BrowserCaptureError after reporting it. */
  start(): Promise<void> {
    this.restartBudget = 1
    return this.startInternal()
  }

  stop(): void {
    this.stopping = true
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const had = this.session !== null
    this.teardown()
    if (had) report({ state: 'stopped' })
    this.stopping = false
  }

  // ---------------------------------------------------------------------------

  private startInternal(): Promise<void> {
    if (this.starting) return this.starting
    if (this.session) return Promise.resolve()
    this.stopping = false
    const p = this.doStart().finally(() => {
      this.starting = null
    })
    this.starting = p
    return p
  }

  private async doStart(): Promise<void> {
    report({ state: 'starting' })

    if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      throw this.fail(
        makeError(
          'BROWSER_CAPTURE_FAILED',
          'This environment cannot capture system audio.',
          'Switch the audio engine to Native helper in Settings > Audio.'
        )
      )
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw this.fail(
          makeError(
            'BROWSER_CAPTURE_DENIED',
            'Windows denied access to system audio.',
            'Allow screen/audio capture for VibeSync or switch the audio engine to Native helper in Settings > Audio.',
            errorDetail(err)
          )
        )
      }
      throw this.fail(
        makeError(
          'BROWSER_CAPTURE_FAILED',
          'Could not start Chromium system-audio capture.',
          'Switch the audio engine to Native helper in Settings > Audio.',
          errorDetail(err)
        )
      )
    }
    if (this.stopping) {
      stopStream(stream)
      return
    }

    // We only want audio: drop the screen video track right away.
    for (const v of stream.getVideoTracks()) {
      try {
        v.stop()
        stream.removeTrack(v)
      } catch {
        /* ignore */
      }
    }
    const track = stream.getAudioTracks()[0]
    if (!track) {
      stopStream(stream)
      throw this.fail(
        makeError(
          'BROWSER_CAPTURE_FAILED',
          'Windows did not provide system audio.',
          'Switch the audio engine to Native helper in Settings > Audio.'
        )
      )
    }

    let ctx: AudioContext
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' })
      if (ctx.state === 'suspended') await ctx.resume()
    } catch (err) {
      stopStream(stream)
      throw this.fail(
        makeError(
          'BROWSER_CAPTURE_FAILED',
          'Could not create the Web Audio context for system-audio capture.',
          'Switch the audio engine to Native helper in Settings > Audio.',
          errorDetail(err)
        )
      )
    }

    let source: MediaStreamAudioSourceNode
    try {
      source = ctx.createMediaStreamSource(stream)
    } catch (err) {
      stopStream(stream)
      void ctx.close().catch(() => {})
      throw this.fail(
        makeError(
          'BROWSER_CAPTURE_FAILED',
          'The system-audio stream could not be routed into the analyser.',
          'Switch the audio engine to Native helper in Settings > Audio.',
          errorDetail(err)
        )
      )
    }

    const mute = ctx.createGain()
    mute.gain.value = 0
    mute.connect(ctx.destination)

    const session: Session = {
      stream,
      track,
      ctx,
      source,
      worklet: null,
      processor: null,
      mute,
      scratch: null,
      onEnded: () => this.onTrackEnded(session)
    }

    const worklet = await this.tryCreateWorklet(ctx)
    if (this.stopping) {
      stopStream(stream)
      void ctx.close().catch(() => {})
      return
    }
    if (worklet) {
      session.worklet = worklet
      worklet.port.onmessage = (ev: MessageEvent<WorkletBatch>) => this.onWorkletBatch(ev.data, ctx.sampleRate)
      source.connect(worklet)
      worklet.connect(mute)
    } else {
      // Fallback for environments where the worklet module cannot be loaded (CSP / file URL).
      let processor: ScriptProcessorNode
      try {
        processor = ctx.createScriptProcessor(SCRIPT_PROCESSOR_FRAMES, CHANNELS, CHANNELS)
      } catch (err) {
        stopStream(stream)
        void ctx.close().catch(() => {})
        throw this.fail(
          makeError(
            'BROWSER_CAPTURE_FAILED',
            'No audio processing path is available for system-audio capture.',
            'Switch the audio engine to Native helper in Settings > Audio.',
            errorDetail(err)
          )
        )
      }
      session.processor = processor
      session.scratch = new Float32Array(SCRIPT_PROCESSOR_FRAMES * CHANNELS)
      processor.onaudioprocess = (ev: AudioProcessingEvent) => this.onScriptProcess(session, ev)
      source.connect(processor)
      processor.connect(mute)
      log('info', 'Browser capture using ScriptProcessorNode fallback')
    }

    track.addEventListener('ended', session.onEnded)
    this.session = session
    report({ state: 'connected', sampleRate: ctx.sampleRate, channels: CHANNELS })
    log('info', `Browser loopback capture connected (${ctx.sampleRate} Hz, ${worklet ? 'AudioWorklet' : 'ScriptProcessor'})`)
  }

  private async tryCreateWorklet(ctx: AudioContext): Promise<AudioWorkletNode | null> {
    if (!ctx.audioWorklet || typeof AudioWorkletNode !== 'function') return null
    const candidates: Array<() => string> = [
      () => new URL('./pcm-worklet.js', import.meta.url).href,
      () => URL.createObjectURL(new Blob([pcmWorkletSource], { type: 'application/javascript' }))
    ]
    for (const make of candidates) {
      let url: string | null = null
      try {
        url = make()
        await ctx.audioWorklet.addModule(url)
        const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [CHANNELS],
          channelCount: CHANNELS,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers'
        })
        return node
      } catch (err) {
        log('warn', 'AudioWorklet module unavailable, trying next path', errorDetail(err))
      } finally {
        if (url && url.startsWith('blob:')) {
          try {
            URL.revokeObjectURL(url)
          } catch {
            /* ignore */
          }
        }
      }
    }
    return null
  }

  private onWorkletBatch(data: WorkletBatch, ctxRate: number): void {
    if (!data || !(data.buffer instanceof ArrayBuffer)) return
    const channels = data.channels && data.channels > 0 ? data.channels : CHANNELS
    const samples = new Float32Array(data.buffer)
    const frames = Math.floor(samples.length / channels)
    if (frames <= 0) return
    const sampleRate = data.sampleRate && data.sampleRate > 0 ? data.sampleRate : ctxRate
    this.engine.pushPcm({ sampleRate, channels, frames, samples, receivedAt: nowMs() })
  }

  private onScriptProcess(session: Session, ev: AudioProcessingEvent): void {
    const input = ev.inputBuffer
    const frames = input.length
    const scratch = session.scratch && session.scratch.length >= frames * CHANNELS ? session.scratch : new Float32Array(frames * CHANNELS)
    session.scratch = scratch
    const left = input.getChannelData(0)
    const right = input.numberOfChannels > 1 ? input.getChannelData(1) : left
    for (let i = 0; i < frames; i++) {
      scratch[i * 2] = left[i]
      scratch[i * 2 + 1] = right[i]
    }
    const samples = scratch.length === frames * CHANNELS ? scratch : scratch.subarray(0, frames * CHANNELS)
    this.engine.pushPcm({ sampleRate: input.sampleRate, channels: CHANNELS, frames, samples, receivedAt: nowMs() })
  }

  private onTrackEnded(session: Session): void {
    if (this.session !== session || this.stopping) return
    log('warn', 'Browser loopback audio track ended (device change?)')
    this.teardown()
    const canRestart = this.restartBudget > 0
    report({
      state: 'error',
      error: makeError(
        'DEVICE_DISCONNECTED',
        'System audio capture stopped because the playback device changed.',
        canRestart ? 'Reconnecting automatically…' : 'Restart audio capture from Settings > Audio.'
      )
    })
    if (!canRestart) return
    this.restartBudget--
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopping) return
      this.startInternal().catch(() => {
        /* already reported */
      })
    }, RESTART_DELAY_MS)
  }

  private fail(error: AppError): BrowserCaptureError {
    log('error', `Browser capture failed: ${error.message}`, error.detail)
    report({ state: 'error', error })
    return new BrowserCaptureError(error)
  }

  private teardown(): void {
    const s = this.session
    this.session = null
    if (!s) return
    try {
      s.track.removeEventListener('ended', s.onEnded)
    } catch {
      /* ignore */
    }
    if (s.worklet) {
      try {
        s.worklet.port.postMessage('stop')
        s.worklet.port.onmessage = null
        s.worklet.disconnect()
      } catch {
        /* ignore */
      }
    }
    if (s.processor) {
      try {
        s.processor.onaudioprocess = null
        s.processor.disconnect()
      } catch {
        /* ignore */
      }
    }
    try {
      s.source.disconnect()
    } catch {
      /* ignore */
    }
    try {
      s.mute.disconnect()
    } catch {
      /* ignore */
    }
    stopStream(s.stream)
    void s.ctx.close().catch(() => {})
  }
}

function stopStream(stream: MediaStream): void {
  for (const t of stream.getTracks()) {
    try {
      t.stop()
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton helpers (bound to an engine by audio/index.ts)
// ---------------------------------------------------------------------------

let singleton: BrowserCaptureSource | null = null

/** Start Chromium loopback capture into `engine`. Resolves once PCM is flowing. */
export function startBrowserCapture(engine: IAudioEngine): Promise<void> {
  if (!singleton) singleton = new BrowserCaptureSource(engine)
  return singleton.start()
}

/** Stop the browser capture (no-op when it is not running). */
export function stopBrowserCapture(): void {
  singleton?.stop()
}

export function isBrowserCaptureActive(): boolean {
  return singleton?.active ?? false
}
