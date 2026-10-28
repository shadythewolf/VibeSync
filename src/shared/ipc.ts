/**
 * IPC channel names and the renderer-facing API surface exposed by the preload
 * script as `window.vibedeck`.
 *
 * Main process: implements every `invoke` channel with ipcMain.handle() and pushes
 * events on the `on*` channels with webContents.send().
 * Preload: wraps channels into the typed VibeDeckApi (see src/preload/index.ts).
 * Renderer: only ever talks to `window.vibedeck`, never to ipcRenderer directly.
 */
import type { LyricsState } from './lyrics'
import type { CaptureEngine, DeepPartial, Settings } from './settings'
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
} from './types'

export const IPC = {
  // settings (invoke)
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsReset: 'settings:reset',
  // settings (event main -> renderer)
  settingsChanged: 'settings:changed',

  // audio (invoke)
  audioGetStatus: 'audio:get-status',
  audioListDevices: 'audio:list-devices',
  audioSelectDevice: 'audio:select-device',
  audioSetEngine: 'audio:set-engine',
  audioRestart: 'audio:restart',
  // audio (renderer -> main, fire and forget)
  audioBrowserReport: 'audio:browser-report',
  // audio (event main -> renderer)
  audioStatus: 'audio:status',
  audioDevices: 'audio:devices',
  audioPcm: 'audio:pcm',

  // track metadata
  lyricsGet: 'lyrics:get',
  lyricsChanged: 'lyrics:changed',
  trackGet: 'track:get',
  trackChanged: 'track:changed',

  // Local Spotify queue
  spotifyQueueGet: 'spotify:queue-get',
  spotifyQueueChanged: 'spotify:queue-changed',
  // Spicetify bridge setup (invoke)
  spotifyBridgeStatus: 'spotify:bridge-status',
  spotifyInstallBridge: 'spotify:install-bridge',

  // window
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowSetFullscreen: 'window:set-fullscreen',
  windowToggleFullscreen: 'window:toggle-fullscreen',
  windowGetState: 'window:get-state',
  windowSetAlwaysOnTop: 'window:set-always-on-top',
  windowStateChanged: 'window:state-changed',

  // app
  appGetInfo: 'app:get-info',
  appOpenExternal: 'app:open-external',
  appOpenLogs: 'app:open-logs',
  appOpenUserData: 'app:open-user-data',
  appRelaunch: 'app:relaunch',
  appQuit: 'app:quit',
  appLog: 'app:log',
  appRendererError: 'app:renderer-error',
  appCheckUpdates: 'app:check-updates',
  appGetUpdateStatus: 'app:get-update-status',
  appDownloadUpdate: 'app:download-update',
  appInstallUpdate: 'app:install-update',
  // event main -> renderer
  appUpdateStatus: 'app:update-status',
  appClearArtworkCache: 'app:clear-artwork-cache',
  // event main -> renderer: the GPU process was lost; canvases must be re-created
  appGpuReset: 'app:gpu-reset'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** Wire format of a PCM chunk over IPC (structured clone friendly). */
export interface PcmWire {
  sampleRate: number
  channels: number
  frames: number
  /** Raw little-endian float32 bytes, interleaved. */
  data: Uint8Array
  receivedAt: number
}

export interface VibeDeckApi {
  settings: {
    get(): Promise<Settings>
    set(patch: DeepPartial<Settings>): Promise<Settings>
    reset(): Promise<Settings>
    onChange(cb: (settings: Settings) => void): Unsubscribe
  }
  audio: {
    getStatus(): Promise<AudioStatus>
    listDevices(): Promise<AudioDevice[]>
    /** null = Windows default output. Persists to settings and restarts capture. */
    selectDevice(deviceId: string | null): Promise<AudioStatus>
    setEngine(engine: CaptureEngine): Promise<AudioStatus>
    restart(): Promise<AudioStatus>
    /** Renderer reports the state of the Chromium loopback fallback it owns. */
    reportBrowserCapture(report: BrowserCaptureReport): void
    onStatus(cb: (status: AudioStatus) => void): Unsubscribe
    onDevices(cb: (devices: AudioDevice[]) => void): Unsubscribe
    onPcm(cb: (chunk: PcmChunk) => void): Unsubscribe
  }
  track: {
    get(): Promise<TrackInfo>
    onChange(cb: (track: TrackInfo) => void): Unsubscribe
  }
  lyrics: {
    get(): Promise<LyricsState>
    onChange(cb: (state: LyricsState) => void): Unsubscribe
  }
  spotify: {
    getQueue(): Promise<SpotifyQueueState>
    onQueue(cb: (state: SpotifyQueueState) => void): Unsubscribe
    getBridgeStatus(): Promise<BridgeSetupStatus>
    /** Copies the bundled bridge into Spicetify, enables it and runs spicetify apply. */
    installBridge(): Promise<BridgeInstallResult>
  }
  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    setFullscreen(fullscreen: boolean): Promise<void>
    toggleFullscreen(): Promise<boolean>
    getState(): Promise<WindowState>
    setAlwaysOnTop(alwaysOnTop: boolean): Promise<void>
    onStateChange(cb: (state: WindowState) => void): Unsubscribe
  }
  app: {
    getInfo(): Promise<AppInfo>
    openExternal(url: string): Promise<void>
    openLogs(): Promise<void>
    openUserData(): Promise<void>
    relaunch(): void
    quit(): void
    log(level: LogLevel, message: string, detail?: string): void
    reportError(report: RendererErrorReport): void
    checkForUpdates(): Promise<UpdateCheckResult>
    getUpdateStatus(): Promise<UpdateCheckResult>
    /** Downloads the available update, or opens the release page when this install cannot self-update. */
    downloadUpdate(): Promise<void>
    /** Quits and installs a downloaded update. */
    installUpdate(): Promise<void>
    onUpdateStatus(cb: (state: UpdateCheckResult) => void): Unsubscribe
    clearArtworkCache(): Promise<void>
    /** Fired after Chromium's GPU process crashed and restarted; canvases must be re-created. */
    onGpuReset(cb: () => void): Unsubscribe
  }
}
