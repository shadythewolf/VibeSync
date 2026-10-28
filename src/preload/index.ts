/**
 * Preload script: exposes a typed, minimal API (`window.vibedeck`) to the renderer.
 * The renderer never gets direct access to ipcRenderer or Node.
 */
import type { LyricsState } from '../shared/lyrics'
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC, type PcmWire, type VibeDeckApi } from '../shared/ipc'
import type { CaptureEngine, DeepPartial, Settings } from '../shared/settings'
import type {
  AppInfo,
  AudioDevice,
  AudioStatus,
  BridgeInstallResult,
  BridgeSetupStatus,
  BrowserCaptureReport,
  LogLevel,
  PcmChunk,
  RendererErrorReport,
  SpotifyQueueState,
  TrackInfo,
  Unsubscribe,
  UpdateCheckResult,
  WindowState
} from '../shared/types'

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

function wireToChunk(w: PcmWire): PcmChunk {
  const bytes = w.data
  let samples: Float32Array
  if (bytes.byteOffset % 4 === 0 && bytes.byteLength % 4 === 0) {
    samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  } else {
    const copy = new Uint8Array(bytes.byteLength - (bytes.byteLength % 4))
    copy.set(bytes.subarray(0, copy.length))
    samples = new Float32Array(copy.buffer)
  }
  return {
    sampleRate: w.sampleRate,
    channels: w.channels,
    frames: w.frames,
    samples,
    receivedAt: w.receivedAt
  }
}

const api: VibeDeckApi = {
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<Settings>,
    set: (patch: DeepPartial<Settings>) => ipcRenderer.invoke(IPC.settingsSet, patch) as Promise<Settings>,
    reset: () => ipcRenderer.invoke(IPC.settingsReset) as Promise<Settings>,
    onChange: (cb) => on<Settings>(IPC.settingsChanged, cb)
  },
  audio: {
    getStatus: () => ipcRenderer.invoke(IPC.audioGetStatus) as Promise<AudioStatus>,
    listDevices: () => ipcRenderer.invoke(IPC.audioListDevices) as Promise<AudioDevice[]>,
    selectDevice: (deviceId: string | null) => ipcRenderer.invoke(IPC.audioSelectDevice, deviceId) as Promise<AudioStatus>,
    setEngine: (engine: CaptureEngine) => ipcRenderer.invoke(IPC.audioSetEngine, engine) as Promise<AudioStatus>,
    restart: () => ipcRenderer.invoke(IPC.audioRestart) as Promise<AudioStatus>,
    reportBrowserCapture: (report: BrowserCaptureReport) => ipcRenderer.send(IPC.audioBrowserReport, report),
    onStatus: (cb) => on<AudioStatus>(IPC.audioStatus, cb),
    onDevices: (cb) => on<AudioDevice[]>(IPC.audioDevices, cb),
    onPcm: (cb) => on<PcmWire>(IPC.audioPcm, (w) => cb(wireToChunk(w)))
  },
  track: {
    get: () => ipcRenderer.invoke(IPC.trackGet) as Promise<TrackInfo>,
    onChange: (cb) => on<TrackInfo>(IPC.trackChanged, cb)
  },
  lyrics: {
    get: () => ipcRenderer.invoke(IPC.lyricsGet) as Promise<LyricsState>,
    onChange: (cb) => on<LyricsState>(IPC.lyricsChanged, cb)
  },
  spotify: {
    getQueue: () => ipcRenderer.invoke(IPC.spotifyQueueGet) as Promise<SpotifyQueueState>,
    onQueue: (cb) => on<SpotifyQueueState>(IPC.spotifyQueueChanged, cb),
    getBridgeStatus: () => ipcRenderer.invoke(IPC.spotifyBridgeStatus) as Promise<BridgeSetupStatus>,
    installBridge: () => ipcRenderer.invoke(IPC.spotifyInstallBridge) as Promise<BridgeInstallResult>
  },
  window: {
    minimize: () => ipcRenderer.send(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.send(IPC.windowToggleMaximize),
    close: () => ipcRenderer.send(IPC.windowClose),
    setFullscreen: (fullscreen: boolean) => ipcRenderer.invoke(IPC.windowSetFullscreen, fullscreen) as Promise<void>,
    toggleFullscreen: () => ipcRenderer.invoke(IPC.windowToggleFullscreen) as Promise<boolean>,
    getState: () => ipcRenderer.invoke(IPC.windowGetState) as Promise<WindowState>,
    setAlwaysOnTop: (v: boolean) => ipcRenderer.invoke(IPC.windowSetAlwaysOnTop, v) as Promise<void>,
    onStateChange: (cb) => on<WindowState>(IPC.windowStateChanged, cb)
  },
  app: {
    getInfo: () => ipcRenderer.invoke(IPC.appGetInfo) as Promise<AppInfo>,
    openExternal: (url: string) => ipcRenderer.invoke(IPC.appOpenExternal, url) as Promise<void>,
    openLogs: () => ipcRenderer.invoke(IPC.appOpenLogs) as Promise<void>,
    openUserData: () => ipcRenderer.invoke(IPC.appOpenUserData) as Promise<void>,
    relaunch: () => ipcRenderer.send(IPC.appRelaunch),
    quit: () => ipcRenderer.send(IPC.appQuit),
    log: (level: LogLevel, message: string, detail?: string) => ipcRenderer.send(IPC.appLog, { level, message, detail }),
    reportError: (report: RendererErrorReport) => ipcRenderer.send(IPC.appRendererError, report),
    checkForUpdates: () => ipcRenderer.invoke(IPC.appCheckUpdates) as Promise<UpdateCheckResult>,
    getUpdateStatus: () => ipcRenderer.invoke(IPC.appGetUpdateStatus) as Promise<UpdateCheckResult>,
    downloadUpdate: () => ipcRenderer.invoke(IPC.appDownloadUpdate) as Promise<void>,
    installUpdate: () => ipcRenderer.invoke(IPC.appInstallUpdate) as Promise<void>,
    onUpdateStatus: (cb) => on<UpdateCheckResult>(IPC.appUpdateStatus, cb),
    clearArtworkCache: () => ipcRenderer.invoke(IPC.appClearArtworkCache) as Promise<void>,
    onGpuReset: (cb) => on<void>(IPC.appGpuReset, () => cb())
  }
}

contextBridge.exposeInMainWorld('vibedeck', api)
