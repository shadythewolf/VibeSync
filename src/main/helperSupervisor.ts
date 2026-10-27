/**
 * Supervises the native helper process (VibeDeckHelper.exe).
 *
 * - Spawns the helper with piped stdio and parses its stdout with the shared FrameParser.
 *   JSON frames become `message` events; PCM frames become `pcm` events carrying the raw
 *   float32 bytes (the preload turns them into a Float32Array - no conversion here).
 * - Commands are written to stdin as JSON lines; anything sent before the helper's
 *   `hello` is queued and flushed once the helper is ready.
 * - Keep-alive: `ping` every 10 s, a missing `pong` within 6 s kills and restarts.
 * - Crash policy: exponential backoff (1 s, 2 s, 4 s ...) with at most 5 restarts per
 *   60 s window, then a `failed` event with HELPER_CRASHED. Exits that look like a
 *   .NET Framework problem fail immediately with DOTNET_MISSING; a helper that dies twice
 *   before ever saying hello fails with HELPER_START_FAILED.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { dirname } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { PcmWire } from '../shared/ipc'
import {
  FrameParser,
  FrameType,
  PCM_HEADER_SIZE,
  PROTOCOL_VERSION,
  parseHelperMessage,
  serializeCommand,
  type HelloMsg,
  type HelperCommand,
  type HelperMessage
} from '../shared/protocol'
import type { AppError } from '../shared/types'
import { defaultMessage, formatExitCode, looksLikeDotnetProblem, makeError } from './errors'
import { log } from './logger'
import { getHelperLaunch, getHelperPath, helperExists } from './paths'

const PING_INTERVAL_MS = 10_000
const PONG_TIMEOUT_MS = 6_000
const RESTART_WINDOW_MS = 60_000
const MAX_RESTARTS_PER_WINDOW = 5
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 16_000
const STOP_GRACE_MS = 1_000
const KILL_SETTLE_MS = 250
/** Exits before the first `hello` are start failures; allow one quick retry. */
const MAX_START_FAILURES = 2
const MAX_QUEUED_COMMANDS = 32
const STDERR_TAIL_CHARS = 8_192
const MAX_PCM_CHANNELS = 32

export type SupervisorState = 'stopped' | 'starting' | 'running' | 'restarting' | 'failed'

export interface HelperExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
  /** True when the exit was requested by stop()/dispose(). */
  expected: boolean
}

export interface HelperRestartInfo {
  attempt: number
  delayMs: number
  reason: string
}

export interface HelperSupervisorEvents {
  /** The helper announced itself; commands flow from here on. */
  hello: [msg: HelloMsg]
  /** Every parsed JSON message (including hello/pong/log). */
  message: [msg: HelperMessage]
  pcm: [wire: PcmWire]
  exit: [info: HelperExitInfo]
  restarting: [info: HelperRestartInfo]
  failed: [error: AppError]
  state: [state: SupervisorState]
}

type HelperChild = ChildProcessByStdio<Writable, Readable, Readable>

function u16le(a: Uint8Array, o: number): number {
  return a[o] | (a[o + 1] << 8)
}

function u32le(a: Uint8Array, o: number): number {
  return (a[o] | (a[o + 1] << 8) | (a[o + 2] << 16)) + a[o + 3] * 0x1000000
}

export class HelperSupervisor extends EventEmitter<HelperSupervisorEvents> {
  private child: HelperChild | null = null
  private runId = 0
  private currentState: SupervisorState = 'stopped'
  private helloReceived = false
  private stopping = false
  private disposed = false
  private queue: HelperCommand[] = []
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartTimes: number[] = []
  private startFailures = 0
  private stderrTail = ''
  private stderrLine = ''
  private killReason: string | null = null
  private lastDroppedBytes = 0
  private readonly parser = new FrameParser((type, _flags, payload) => this.onFrame(type, payload))

  get state(): SupervisorState {
    return this.currentState
  }

  /** True when the helper process is alive (it may not have said hello yet). */
  get isRunning(): boolean {
    return this.child !== null
  }

  /** True once the helper accepted commands. */
  get isReady(): boolean {
    return this.child !== null && this.helloReceived
  }

  /** Spawn the helper (no-op when already running). Emits `failed` when the exe is missing. */
  start(): void {
    if (this.disposed) return
    this.stopping = false
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.child) return
    if (!helperExists()) {
      this.fail(makeError('HELPER_MISSING', defaultMessage('HELPER_MISSING'), undefined, getHelperPath()))
      return
    }
    this.restartTimes = []
    this.startFailures = 0
    this.spawnChild()
  }

  /**
   * Write a command to the helper. Returns true when written immediately; commands sent
   * before `hello` are queued (latest start/stop wins, pings and quit are never queued).
   */
  send(cmd: HelperCommand): boolean {
    const child = this.child
    if (child && this.helloReceived && child.stdin.writable) {
      try {
        child.stdin.write(serializeCommand(cmd))
        return true
      } catch (err) {
        log('warn', `Could not write '${cmd.cmd}' to the helper`, err)
        return false
      }
    }
    if (cmd.cmd === 'ping' || cmd.cmd === 'quit') return false
    if (cmd.cmd === 'start' || cmd.cmd === 'stop') {
      this.queue = this.queue.filter((c) => c.cmd !== 'start' && c.cmd !== 'stop')
    }
    this.queue.push(cmd)
    if (this.queue.length > MAX_QUEUED_COMMANDS) this.queue.shift()
    return false
  }

  /** Ask the helper to quit, wait up to 1 s, then kill it. Prevents automatic restarts. */
  stop(): Promise<void> {
    this.stopping = true
    this.queue = []
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.clearKeepAlive()
    const child = this.child
    if (!child) {
      if (this.currentState !== 'failed') this.setState('stopped')
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      let done = false
      let killTimer: ReturnType<typeof setTimeout> | null = null
      const finish = (): void => {
        if (done) return
        done = true
        if (killTimer !== null) clearTimeout(killTimer)
        resolve()
      }
      child.once('exit', finish)
      killTimer = setTimeout(() => {
        killTimer = null
        if (done) return
        log('warn', 'Helper did not exit within the grace period; terminating it')
        this.killChild(child)
        setTimeout(finish, KILL_SETTLE_MS)
      }, STOP_GRACE_MS)
      this.requestQuit(child)
    })
  }

  /** Synchronous last-resort teardown for process exit paths. */
  dispose(): void {
    this.disposed = true
    this.stopping = true
    this.queue = []
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.clearKeepAlive()
    const child = this.child
    if (!child) return
    this.requestQuit(child)
    this.killChild(child)
    this.child = null
    this.setState('stopped')
  }

  // ---------------------------------------------------------------------------
  // Process lifecycle
  // ---------------------------------------------------------------------------

  private spawnChild(): void {
    const helperPath = getHelperPath()
    const launch = getHelperLaunch()
    this.setState(this.currentState === 'restarting' ? 'restarting' : 'starting')
    let child: HelperChild
    try {
      child = spawn(launch.command, launch.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: dirname(helperPath),
        env: launch.env
      })
    } catch (err) {
      this.handleSpawnError(err)
      return
    }
    const runId = ++this.runId
    this.child = child
    this.helloReceived = false
    this.stderrTail = ''
    this.stderrLine = ''
    this.killReason = null
    this.lastDroppedBytes = 0
    this.parser.reset()
    log('info', `Helper spawned (pid ${child.pid ?? '?'})`, helperPath)

    child.stdout.on('data', (chunk: Buffer) => {
      if (runId !== this.runId) return
      this.parser.push(chunk)
      if (this.parser.droppedBytes !== this.lastDroppedBytes) {
        log('warn', `Helper stream resynchronised (${this.parser.droppedBytes - this.lastDroppedBytes} bytes dropped)`)
        this.lastDroppedBytes = this.parser.droppedBytes
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => {
      if (runId !== this.runId) return
      this.onStderr(text)
    })
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      // EPIPE when the helper died while we were writing; the exit handler takes over.
      if (runId !== this.runId) return
      if (err.code !== 'EPIPE') log('warn', 'Helper stdin error', err)
    })
    child.on('error', (err) => {
      if (runId !== this.runId) return
      this.handleSpawnError(err)
    })
    child.on('exit', (code, signal) => {
      if (runId !== this.runId) return
      this.handleExit(code, signal)
    })
  }

  private handleSpawnError(err: unknown): void {
    const e = err as NodeJS.ErrnoException
    this.runId++ // ignore any late events from this attempt
    const child = this.child
    this.child = null
    this.clearKeepAlive()
    if (child) this.killChild(child)
    const detail = e && typeof e === 'object' ? `${e.code ?? ''} ${e.message ?? String(err)}`.trim() : String(err)
    if (e && e.code === 'ENOENT') {
      this.fail(makeError('HELPER_MISSING', defaultMessage('HELPER_MISSING'), undefined, detail))
    } else {
      this.fail(makeError('HELPER_START_FAILED', defaultMessage('HELPER_START_FAILED'), undefined, detail))
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null
    this.clearKeepAlive()
    this.parser.reset()
    const hadHello = this.helloReceived
    this.helloReceived = false
    const expected = this.stopping || this.disposed
    const stderr = this.stderrTail + this.stderrLine
    const reason = this.killReason
    this.killReason = null

    this.emit('exit', { code, signal, expected })
    if (expected) {
      log('info', `Helper exited (code ${formatExitCode(code)})`)
      this.setState('stopped')
      return
    }

    const why = reason ? `killed: ${reason}` : `code ${formatExitCode(code)}${signal ? `, signal ${signal}` : ''}`
    log('warn', `Helper exited unexpectedly (${why})`, stderr || undefined)

    if (!reason && looksLikeDotnetProblem(code, stderr)) {
      this.fail(
        makeError(
          'DOTNET_MISSING',
          defaultMessage('DOTNET_MISSING'),
          undefined,
          `exit code ${formatExitCode(code)}${stderr ? `\n${stderr}` : ''}`
        )
      )
      return
    }
    if (!hadHello && !reason) {
      this.startFailures++
      if (this.startFailures >= MAX_START_FAILURES) {
        this.fail(
          makeError(
            'HELPER_START_FAILED',
            defaultMessage('HELPER_START_FAILED'),
            undefined,
            `The helper exited before initialising (exit code ${formatExitCode(code)}).${stderr ? `\n${stderr}` : ''}`
          )
        )
        return
      }
    }
    this.scheduleRestart(reason ?? `exit code ${formatExitCode(code)}`, stderr)
  }

  private scheduleRestart(reason: string, stderr: string): void {
    const now = Date.now()
    this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS)
    if (this.restartTimes.length >= MAX_RESTARTS_PER_WINDOW) {
      this.fail(
        makeError(
          'HELPER_CRASHED',
          defaultMessage('HELPER_CRASHED'),
          undefined,
          `Gave up after ${this.restartTimes.length} restarts in ${RESTART_WINDOW_MS / 1000} s (last: ${reason}).${stderr ? `\n${stderr}` : ''}`
        )
      )
      return
    }
    const attempt = this.restartTimes.length + 1
    const delayMs = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1))
    this.restartTimes.push(now)
    this.setState('restarting')
    log('info', `Restarting helper in ${delayMs} ms (attempt ${attempt}/${MAX_RESTARTS_PER_WINDOW}, ${reason})`)
    this.emit('restarting', { attempt, delayMs, reason })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopping || this.disposed || this.child) return
      if (!helperExists()) {
        this.fail(makeError('HELPER_MISSING', defaultMessage('HELPER_MISSING'), undefined, getHelperPath()))
        return
      }
      this.spawnChild()
    }, delayMs)
  }

  private fail(error: AppError): void {
    this.queue = []
    this.clearKeepAlive()
    this.setState('failed')
    log('error', `Helper unavailable: ${error.code} - ${error.message}`, error.detail)
    this.emit('failed', error)
  }

  private requestQuit(child: HelperChild): void {
    try {
      if (child.stdin.writable) {
        child.stdin.write(serializeCommand({ cmd: 'quit' }))
        child.stdin.end()
      }
    } catch {
      /* the process may already be gone */
    }
  }

  private killChild(child: HelperChild): void {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    } catch (err) {
      log('warn', 'Could not kill the helper process', err)
    }
  }

  private setState(state: SupervisorState): void {
    if (this.currentState === state) return
    this.currentState = state
    this.emit('state', state)
  }

  // ---------------------------------------------------------------------------
  // Stream handling
  // ---------------------------------------------------------------------------

  private onFrame(type: number, payload: Uint8Array): void {
    if (type === FrameType.Pcm) this.onPcmFrame(payload)
    else if (type === FrameType.Json) this.onJsonFrame(payload)
    else log('warn', `Helper sent a frame of unknown type ${type} (${payload.length} bytes)`)
  }

  private onJsonFrame(payload: Uint8Array): void {
    const msg = parseHelperMessage(payload)
    if (!msg) {
      log('warn', 'Helper sent an unparsable JSON frame', `${payload.length} bytes`)
      return
    }
    switch (msg.type) {
      case 'hello':
        this.onHello(msg)
        break
      case 'pong':
        if (this.pongTimer !== null) {
          clearTimeout(this.pongTimer)
          this.pongTimer = null
        }
        break
      case 'log': {
        const level = msg.level === 'debug' || msg.level === 'info' || msg.level === 'warn' || msg.level === 'error' ? msg.level : 'info'
        log(level, `[helper] ${typeof msg.message === 'string' ? msg.message : JSON.stringify(msg.message)}`)
        break
      }
      default:
        break
    }
    this.emit('message', msg)
  }

  private onPcmFrame(payload: Uint8Array): void {
    if (payload.length < PCM_HEADER_SIZE) return
    const sampleRate = u32le(payload, 0)
    const channels = u16le(payload, 4)
    const format = u16le(payload, 6)
    const frames = u32le(payload, 8)
    if (format !== 1 || channels < 1 || channels > MAX_PCM_CHANNELS || sampleRate < 8000 || sampleRate > 384000) {
      log('warn', `Helper sent a PCM frame with an invalid header (rate ${sampleRate}, ch ${channels}, fmt ${format})`)
      return
    }
    const byteLength = frames * channels * 4
    if (byteLength === 0) return
    if (PCM_HEADER_SIZE + byteLength > payload.length) {
      log('warn', `Helper sent a truncated PCM frame (${payload.length} < ${PCM_HEADER_SIZE + byteLength} bytes)`)
      return
    }
    // Copy into an exact-size buffer: `payload` is a view into the parser's read buffer and
    // structured clone (IPC) would otherwise serialise the whole underlying chunk. The copy is
    // 4-byte aligned at offset 0 so the preload can alias it as a Float32Array without copying.
    const data = new Uint8Array(byteLength)
    data.set(payload.subarray(PCM_HEADER_SIZE, PCM_HEADER_SIZE + byteLength))
    this.emit('pcm', { sampleRate, channels, frames, data, receivedAt: Date.now() })
  }

  private onHello(msg: HelloMsg): void {
    const child = this.child
    if (!child) return
    this.helloReceived = true
    this.startFailures = 0
    this.setState('running')
    log(
      'info',
      `Helper ready (pid ${msg.pid}, helper ${msg.helperVersion}, protocol ${msg.version}, .NET ${msg.dotnet})`
    )
    if (msg.version !== PROTOCOL_VERSION) {
      log('warn', `Helper protocol version ${msg.version} differs from expected ${PROTOCOL_VERSION}; continuing best effort`)
    }
    const queued = this.queue
    this.queue = []
    for (const cmd of queued) this.send(cmd)
    this.startKeepAlive()
    this.emit('hello', msg)
  }

  private onStderr(text: string): void {
    this.stderrLine += text
    let idx = this.stderrLine.indexOf('\n')
    while (idx !== -1) {
      const line = this.stderrLine.slice(0, idx).replace(/\r$/, '')
      this.stderrLine = this.stderrLine.slice(idx + 1)
      if (line.trim().length > 0) {
        log('warn', `[helper:stderr] ${line}`)
        this.stderrTail += line + '\n'
        if (this.stderrTail.length > STDERR_TAIL_CHARS) this.stderrTail = this.stderrTail.slice(-STDERR_TAIL_CHARS)
      }
      idx = this.stderrLine.indexOf('\n')
    }
    if (this.stderrLine.length > STDERR_TAIL_CHARS) this.stderrLine = this.stderrLine.slice(-STDERR_TAIL_CHARS)
  }

  // ---------------------------------------------------------------------------
  // Keep-alive
  // ---------------------------------------------------------------------------

  private startKeepAlive(): void {
    this.clearKeepAlive()
    this.pingTimer = setInterval(() => {
      const child = this.child
      if (!child || !this.helloReceived) return
      if (!this.send({ cmd: 'ping' })) return
      if (this.pongTimer !== null) return
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null
        if (this.child !== child || this.stopping) return
        log('warn', `Helper did not answer ping within ${PONG_TIMEOUT_MS} ms; restarting it`)
        this.killReason = 'unresponsive'
        this.killChild(child)
      }, PONG_TIMEOUT_MS)
    }, PING_INTERVAL_MS)
  }

  private clearKeepAlive(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }
}
