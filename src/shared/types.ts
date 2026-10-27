/**
 * Shared runtime types exchanged between the main process, preload and renderer.
 * Must stay free of Node/DOM specific imports.
 */

export type CaptureEngineKind = 'helper' | 'browser'

export type CaptureState = 'idle' | 'starting' | 'connected' | 'reconnecting' | 'error'

export type ErrorCode =
  | 'HELPER_MISSING'
  | 'HELPER_START_FAILED'
  | 'HELPER_CRASHED'
  | 'HELPER_PROTOCOL'
  | 'DOTNET_MISSING'
  | 'CAPTURE_INIT_FAILED'
  | 'DEVICE_NOT_FOUND'
  | 'DEVICE_DISCONNECTED'
  | 'NO_AUDIO_DEVICE'
  | 'BROWSER_CAPTURE_FAILED'
  | 'BROWSER_CAPTURE_DENIED'
  | 'UNSUPPORTED_PLATFORM'
  | 'SETTINGS_IO'
  | 'RENDERER_CRASH'
  | 'UNKNOWN'

export interface AppError {
  code: ErrorCode
  /** Human readable, one sentence, safe to show in the UI. */
  message: string
  /** How the user can fix it. */
  hint?: string
  /** Technical detail (exception text) for the diagnostics panel / log. */
  detail?: string
}

export interface AudioDevice {
  /** WASAPI endpoint id, e.g. "{0.0.0.00000000}.{guid}". */
  id: string
  /** Friendly name, e.g. "Speakers (Realtek(R) Audio)". */
  name: string
  isDefault: boolean
  sampleRate: number
  channels: number
}

export interface AudioStatus {
  state: CaptureState
  engine: CaptureEngineKind | null
  /** What the user asked for (null = Windows default output). */
  requestedDeviceId: string | null
  /** What is actually being captured right now. */
  deviceId: string | null
  deviceName: string | null
  sampleRate: number
  channels: number
  error: AppError | null
  /** The native helper executable exists on disk. */
  helperAvailable: boolean
  /** Number of PCM chunks received since capture started (diagnostics). */
  chunksReceived: number
  updatedAt: number
}

export type PlaybackStatus = 'playing' | 'paused' | 'stopped' | 'changing' | 'opening' | 'closed' | 'unknown'

export interface TrackInfo {
  /** False when no media session reports anything (show "Unknown Track"). */
  available: boolean
  title: string
  artist: string
  album: string
  /** AppUserModelId of the source app (e.g. "AppleInc.AppleMusicWin_nzyj5cx40ttqa!App"). */
  sourceApp: string
  /** Best-effort friendly name ("Apple Music", "Spotify", "Chrome"). */
  sourceAppName: string
  status: PlaybackStatus
  positionMs: number
  durationMs: number
  /** Epoch ms when positionMs was reported; renderer interpolates while playing. */
  positionUpdatedAt: number
  /** Stable hash of the artwork bytes, null when there is none. */
  artworkKey: string | null
  /** Renderable URL (data: URL) for the artwork, null when there is none. */
  artworkUrl: string | null
  /** Stable id for the current track (title|artist|album) - used to reset per-track state. */
  trackId: string
}

export interface SpotifyQueueState {
  currentTrackId: string
  nextTrack: Pick<TrackInfo, 'trackId' | 'title' | 'artist' | 'album' | 'artworkUrl'> | null
  error: string | null
}

export const EMPTY_SPOTIFY_QUEUE: SpotifyQueueState = { currentTrackId: '', nextTrack: null, error: null }

export const UNKNOWN_TRACK: TrackInfo = {
  available: false,
  title: 'Unknown Track',
  artist: 'Unknown Artist',
  album: '',
  sourceApp: '',
  sourceAppName: '',
  status: 'unknown',
  positionMs: 0,
  durationMs: 0,
  positionUpdatedAt: 0,
  artworkKey: null,
  artworkUrl: null,
  trackId: ''
}

export interface WindowState {
  isMaximized: boolean
  isMinimized: boolean
  isFullScreen: boolean
  isAlwaysOnTop: boolean
  isFocused: boolean
  /**
   * False while the window is hidden to the tray or minimized. The renderer pauses its
   * render loop on this: `backgroundThrottling` is off, so `document.visibilityState`
   * alone stays "visible" and would keep the visualizer drawing into nothing.
   */
  isVisible: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  osVersion: string
  userDataPath: string
  logPath: string
  helperPath: string
  helperFound: boolean
  isPackaged: boolean
  isPortable: boolean
  /** True when an update feed URL is compiled in. */
  updatesConfigured: boolean
  /** False when the visualizer is rendering on the CPU. */
  hardwareAcceleration: boolean
  /** True when this launch is the automatic fallback after repeated GPU crashes. */
  gpuFallbackApplied: boolean
}

export interface UpdateCheckResult {
  status: 'not-configured' | 'up-to-date' | 'available' | 'error' | 'checking'
  version?: string
  message?: string
}

/** Interleaved float32 PCM chunk delivered to the renderer. */
export interface PcmChunk {
  sampleRate: number
  channels: number
  /** Number of frames (samples per channel). */
  frames: number
  /** Interleaved samples, length === frames * channels. */
  samples: Float32Array
  /** performance/epoch time when the main process received it (ms). */
  receivedAt: number
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface RendererErrorReport {
  message: string
  stack?: string
  componentStack?: string
  source?: string
}

/** Report sent by the renderer when it owns capture (browser loopback fallback). */
export interface BrowserCaptureReport {
  state: 'starting' | 'connected' | 'error' | 'stopped'
  sampleRate?: number
  channels?: number
  error?: AppError
}

export type Unsubscribe = () => void
