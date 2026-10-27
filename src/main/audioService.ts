/**
 * AudioService - the single source of truth for `AudioStatus`.
 *
 * Engine selection (settings.audio.engine):
 *   'helper'  - native WASAPI helper only.
 *   'browser' - Chromium loopback only. Main publishes { engine: 'browser', state: 'starting' };
 *               the renderer starts getDisplayMedia and reports back through
 *               IPC.audioBrowserReport -> handleBrowserReport().
 *   'auto'    - helper first; when the supervisor gives up (`failed`) fall back to browser
 *               mode and keep the helper error in `status.error` so the UI can explain.
 *
 * Every state change is logged and broadcast on IPC.audioStatus to all windows. PCM chunks
 * are forwarded to the main window only (IPC.audioPcm) and counted, never broadcast as status.
 */
import { BrowserWindow } from 'electron'
import { IPC, type PcmWire } from '../shared/ipc'
import type { CaptureEngine } from '../shared/settings'
import type { CaptureMsg, DevicesMsg, ErrorMsg, HelperMessage } from '../shared/protocol'
import type { AppError, AudioDevice, AudioStatus, BrowserCaptureReport } from '../shared/types'
import { defaultMessage, fromHelperError, isErrorCode, makeError } from './errors'
import type { HelperSupervisor } from './helperSupervisor'
import { log } from './logger'
import { helperExists } from './paths'
import { settingsStore } from './settingsStore'
import { getMainWindow } from './window'

const DEVICE_LIST_TIMEOUT_MS = 3_000
const BROWSER_DEVICE_NAME = 'System default output (Chromium loopback)'

type ActiveEngine = 'none' | 'helper' | 'browser'

function initialStatus(): AudioStatus {
  return {
    state: 'idle',
    engine: null,
    requestedDeviceId: null,
    deviceId: null,
    deviceName: null,
    sampleRate: 0,
    channels: 0,
    error: null,
    helperAvailable: helperExists(),
    chunksReceived: 0,
    updatedAt: Date.now()
  }
}

function sanitizeDevice(d: unknown): AudioDevice | null {
  if (typeof d !== 'object' || d === null) return null
  const o = d as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id.length === 0) return null
  return {
    id: o.id,
    name: typeof o.name === 'string' && o.name.length > 0 ? o.name : 'Unknown device',
    isDefault: o.isDefault === true,
    sampleRate: typeof o.sampleRate === 'number' && Number.isFinite(o.sampleRate) ? o.sampleRate : 0,
    channels: typeof o.channels === 'number' && Number.isFinite(o.channels) ? o.channels : 0
  }
}

export class AudioService {
  private status: AudioStatus = initialStatus()
  private chunks = 0
  private devices: AudioDevice[] = []
  private deviceWaiters: Array<(devices: AudioDevice[]) => void> = []
  private active: ActiveEngine = 'none'
  private engineSetting: CaptureEngine
  private requestedDeviceId: string | null
  private stopping = false
  private opChain: Promise<void> = Promise.resolve()

  constructor(private readonly supervisor: HelperSupervisor) {
    const audio = settingsStore.get().audio
    this.engineSetting = audio.engine
    this.requestedDeviceId = audio.deviceId
    this.status.requestedDeviceId = audio.deviceId

    supervisor.on('hello', () => this.onHelperHello())
    supervisor.on('message', (msg) => this.onHelperMessage(msg))
    supervisor.on('pcm', (wire) => this.onPcm(wire))
    supervisor.on('restarting', (info) => this.onHelperRestarting(info.attempt, info.reason))
    supervisor.on('failed', (err) => this.onHelperFailed(err))
    supervisor.on('exit', (info) => {
      if (!info.expected && this.active === 'helper') this.resolveDeviceWaiters()
    })
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getStatus(): AudioStatus {
    return { ...this.status, chunksReceived: this.chunks }
  }

  getDevices(): AudioDevice[] {
    return this.devices
  }

  /** Begin capture according to the current settings. */
  start(): void {
    void this.enqueue(() => this.startInternal())
  }

  /** Stop capture (helper process included). */
  stop(): Promise<void> {
    return this.enqueue(() => this.stopInternal())
  }

  /** Stop everything and start again with the current settings. */
  async restart(): Promise<AudioStatus> {
    await this.enqueue(async () => {
      log('info', 'Audio: restart requested')
      await this.stopInternal()
      this.startInternal()
    })
    return this.getStatus()
  }

  /** Serialises start/stop/restart; a failing operation is logged and never poisons the chain. */
  private enqueue(op: () => void | Promise<void>): Promise<void> {
    this.opChain = this.opChain
      .then(op)
      .catch((err: unknown) => log('error', 'Audio operation failed', err))
    return this.opChain
  }

  /** Fresh device list from the helper (falls back to the cached list after a timeout). */
  listDevices(): Promise<AudioDevice[]> {
    if (this.active !== 'helper' || !this.supervisor.isRunning) return Promise.resolve(this.devices)
    return new Promise<AudioDevice[]>((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.deviceWaiters = this.deviceWaiters.filter((w) => w !== waiter)
        log('warn', 'Audio: device list request timed out; using cached list')
        resolve(this.devices)
      }, DEVICE_LIST_TIMEOUT_MS)
      const waiter = (devices: AudioDevice[]): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(devices)
      }
      this.deviceWaiters.push(waiter)
      this.supervisor.send({ cmd: 'listDevices' })
    })
  }

  /** Persist the requested device and re-target capture (null = Windows default output). */
  async selectDevice(deviceId: string | null): Promise<AudioStatus> {
    const id = typeof deviceId === 'string' && deviceId.length > 0 && deviceId.length < 512 ? deviceId : null
    this.requestedDeviceId = id
    settingsStore.set({ audio: { deviceId: id } })
    log('info', `Audio: device selected -> ${id ?? 'system default output'}`)
    if (this.active === 'helper') {
      this.chunks = 0
      this.update({ state: 'starting', requestedDeviceId: id, error: null })
      this.supervisor.send({ cmd: 'start', deviceId: id })
    } else {
      this.update({ requestedDeviceId: id })
    }
    return this.getStatus()
  }

  /** Persist the engine choice and restart capture with it. */
  setEngine(engine: CaptureEngine): Promise<AudioStatus> {
    this.engineSetting = engine
    settingsStore.set({ audio: { engine } })
    log('info', `Audio: engine set to '${engine}'`)
    return this.restart()
  }

  /**
   * Called by the settings listener when audio.engine / audio.deviceId change through any
   * other path (settings panel, reset). Changes originating here are already applied.
   */
  applySettings(): void {
    const audio = settingsStore.get().audio
    if (audio.engine !== this.engineSetting) {
      this.engineSetting = audio.engine
      this.requestedDeviceId = audio.deviceId
      log('info', `Audio: engine changed in settings -> '${audio.engine}'`)
      void this.restart()
      return
    }
    if (audio.deviceId !== this.requestedDeviceId) {
      void this.selectDevice(audio.deviceId)
    }
  }

  /**
   * A renderer finished loading (first load, reload, or recovery after a crash).
   * Chromium loopback lives in the renderer, so a reload silently drops it while our
   * status still says "connected": re-arm it by publishing `starting` again, which is
   * what the renderer listens for.
   */
  handleRendererReady(): void {
    if (this.active !== 'browser' || this.stopping) return
    log('info', 'Audio: renderer reloaded; re-arming Chromium loopback capture')
    this.chunks = 0
    this.update({ state: 'starting', deviceName: null, sampleRate: 0, channels: 0 })
  }

  /** The renderer owns Chromium loopback capture and reports its state here. */
  handleBrowserReport(report: BrowserCaptureReport): void {
    if (this.active !== 'browser') {
      log('debug', `Audio: ignoring browser capture report '${report.state}' while engine is '${this.active}'`)
      return
    }
    switch (report.state) {
      case 'starting':
        this.update({ state: 'starting' })
        break
      case 'connected':
        this.update({
          state: 'connected',
          deviceId: null,
          deviceName: BROWSER_DEVICE_NAME,
          sampleRate: typeof report.sampleRate === 'number' && report.sampleRate > 0 ? report.sampleRate : 0,
          channels: typeof report.channels === 'number' && report.channels > 0 ? report.channels : 0
        })
        break
      case 'error': {
        const err = this.sanitizeBrowserError(report.error)
        this.update({ state: 'error', error: err, deviceName: null, sampleRate: 0, channels: 0 })
        break
      }
      case 'stopped':
        if (!this.stopping) this.update({ state: 'idle', deviceName: null, sampleRate: 0, channels: 0 })
        break
      default:
        break
    }
  }

  // ---------------------------------------------------------------------------
  // Start / stop
  // ---------------------------------------------------------------------------

  private startInternal(): void {
    this.stopping = false
    const helperAvailable = helperExists()
    this.status.helperAvailable = helperAvailable
    const engine = this.engineSetting
    log('info', `Audio: starting (engine '${engine}', helper ${helperAvailable ? 'found' : 'missing'})`)

    if (engine === 'browser') {
      this.startBrowser(null)
      return
    }
    if (!helperAvailable) {
      const err = makeError('HELPER_MISSING', defaultMessage('HELPER_MISSING'))
      if (engine === 'auto') {
        log('warn', 'Audio: helper missing; falling back to Chromium loopback')
        this.startBrowser(err)
      } else {
        this.active = 'none'
        this.chunks = 0
        this.update({ engine: 'helper', state: 'error', error: err, deviceId: null, deviceName: null, sampleRate: 0, channels: 0 })
      }
      return
    }
    this.active = 'helper'
    this.chunks = 0
    this.update({
      engine: 'helper',
      state: 'starting',
      error: null,
      requestedDeviceId: this.requestedDeviceId,
      deviceId: null,
      deviceName: null,
      sampleRate: 0,
      channels: 0
    })
    this.supervisor.start()
    if (this.supervisor.isReady) this.supervisor.send({ cmd: 'start', deviceId: this.requestedDeviceId })
  }

  private startBrowser(helperError: AppError | null): void {
    this.active = 'browser'
    this.chunks = 0
    this.update({
      engine: 'browser',
      state: 'starting',
      error: helperError,
      requestedDeviceId: this.requestedDeviceId,
      deviceId: null,
      deviceName: null,
      sampleRate: 0,
      channels: 0
    })
  }

  private async stopInternal(): Promise<void> {
    if (this.active === 'none' && !this.supervisor.isRunning) return
    this.stopping = true
    const was = this.active
    this.active = 'none'
    this.resolveDeviceWaiters()
    if (was === 'helper' || this.supervisor.isRunning) {
      this.supervisor.send({ cmd: 'stop' })
      await this.supervisor.stop()
    }
    this.chunks = 0
    this.update({ state: 'idle', engine: null, error: null, deviceId: null, deviceName: null, sampleRate: 0, channels: 0 })
    log('info', `Audio: stopped (was '${was}')`)
  }

  // ---------------------------------------------------------------------------
  // Helper events
  // ---------------------------------------------------------------------------

  private onHelperHello(): void {
    if (this.active !== 'helper') return
    this.supervisor.send({ cmd: 'start', deviceId: this.requestedDeviceId })
  }

  private onHelperMessage(msg: HelperMessage): void {
    switch (msg.type) {
      case 'capture':
        this.onCapture(msg)
        break
      case 'devices':
        this.onDevices(msg)
        break
      case 'deviceChange':
        log('info', `Audio: Windows device change (${msg.kind})`, msg.deviceId ?? undefined)
        break
      case 'error':
        this.onHelperError(msg)
        break
      default:
        break
    }
  }

  private onCapture(msg: CaptureMsg): void {
    if (this.active !== 'helper') return
    switch (msg.state) {
      case 'started':
        this.chunks = 0
        this.update({
          state: 'connected',
          error: null,
          deviceId: typeof msg.deviceId === 'string' ? msg.deviceId : null,
          deviceName: typeof msg.deviceName === 'string' ? msg.deviceName : null,
          sampleRate: typeof msg.sampleRate === 'number' ? msg.sampleRate : 0,
          channels: typeof msg.channels === 'number' ? msg.channels : 0
        })
        break
      case 'restarting':
        this.update({
          state: 'reconnecting',
          error: msg.error ? fromHelperError(msg.error, 'DEVICE_DISCONNECTED') : null
        })
        break
      case 'error': {
        const err = fromHelperError(msg.error, 'CAPTURE_INIT_FAILED')
        if (this.status.state === 'reconnecting') this.update({ error: err })
        else this.update({ state: 'error', error: err, sampleRate: 0, channels: 0 })
        break
      }
      case 'stopped':
        if (!this.stopping && this.status.state !== 'starting') {
          this.update({ state: 'idle', deviceId: null, deviceName: null, sampleRate: 0, channels: 0 })
        }
        break
      default:
        break
    }
  }

  private onDevices(msg: DevicesMsg): void {
    const list = Array.isArray(msg.devices) ? msg.devices : []
    const devices: AudioDevice[] = []
    for (const d of list) {
      const dev = sanitizeDevice(d)
      if (dev) devices.push(dev)
    }
    this.devices = devices
    log('info', `Audio: ${devices.length} playback device(s)`, devices.map((d) => `${d.isDefault ? '*' : ' '}${d.name}`).join('; '))
    this.resolveDeviceWaiters()
    this.broadcast(IPC.audioDevices, devices)
  }

  private onHelperError(msg: ErrorMsg): void {
    const code = typeof msg.code === 'string' ? msg.code : 'UNKNOWN'
    switch (code) {
      case 'CAPTURE_INIT_FAILED': {
        if (this.active !== 'helper') return
        const err = fromHelperError(msg, 'CAPTURE_INIT_FAILED')
        this.update({ state: 'error', error: err })
        break
      }
      case 'DEVICE_ENUM_FAILED':
        log('warn', `Audio: ${msg.message}`, msg.detail)
        this.resolveDeviceWaiters()
        break
      case 'HELPER_CRASHED':
        log('error', `Audio: helper reported an internal error - ${msg.message}`, msg.detail)
        break
      default:
        log('warn', `Audio: helper error ${code} - ${msg.message}`, msg.detail)
        break
    }
  }

  private onHelperRestarting(attempt: number, reason: string): void {
    if (this.active !== 'helper') return
    this.update({
      state: 'reconnecting',
      deviceId: null,
      deviceName: null,
      sampleRate: 0,
      channels: 0,
      error: makeError(
        'HELPER_CRASHED',
        'The audio helper stopped unexpectedly; restarting it.',
        undefined,
        `${reason} (attempt ${attempt})`
      )
    })
  }

  private onHelperFailed(err: AppError): void {
    if (this.active !== 'helper') return
    this.resolveDeviceWaiters()
    if (this.engineSetting === 'auto') {
      log('warn', `Audio: helper failed (${err.code}); falling back to Chromium loopback`)
      this.startBrowser(err)
      return
    }
    this.update({ state: 'error', error: err, deviceId: null, deviceName: null, sampleRate: 0, channels: 0 })
  }

  private onPcm(wire: PcmWire): void {
    if (this.active !== 'helper') return
    this.chunks++
    const win = getMainWindow()
    if (!win) return
    win.webContents.send(IPC.audioPcm, wire)
  }

  // ---------------------------------------------------------------------------
  // Status plumbing
  // ---------------------------------------------------------------------------

  private update(patch: Partial<Omit<AudioStatus, 'chunksReceived' | 'updatedAt'>>): void {
    const prev = this.status
    const next: AudioStatus = { ...prev, ...patch, chunksReceived: this.chunks, updatedAt: Date.now() }
    this.status = next
    if (prev.state !== next.state || prev.engine !== next.engine || prev.error?.code !== next.error?.code) {
      const where = next.deviceName ? ` on "${next.deviceName}"` : ''
      const rate = next.sampleRate ? ` ${next.sampleRate} Hz / ${next.channels} ch` : ''
      const err = next.error ? ` [${next.error.code}: ${next.error.message}]` : ''
      log('info', `Audio: ${prev.engine ?? '-'}/${prev.state} -> ${next.engine ?? '-'}/${next.state}${where}${rate}${err}`)
    }
    this.broadcast(IPC.audioStatus, next)
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send(channel, payload)
      } catch (err) {
        log('warn', `Broadcast on ${channel} failed`, err)
      }
    }
  }

  private resolveDeviceWaiters(): void {
    const waiters = this.deviceWaiters
    this.deviceWaiters = []
    for (const w of waiters) w(this.devices)
  }

  private sanitizeBrowserError(e: AppError | undefined): AppError {
    if (e && typeof e === 'object' && isErrorCode(e.code) && typeof e.message === 'string' && e.message.length > 0) {
      return makeError(
        e.code,
        e.message.slice(0, 500),
        typeof e.hint === 'string' && e.hint.length > 0 ? e.hint.slice(0, 500) : undefined,
        typeof e.detail === 'string' ? e.detail : undefined
      )
    }
    return makeError('BROWSER_CAPTURE_FAILED', defaultMessage('BROWSER_CAPTURE_FAILED'))
  }
}
