/**
 * VibeSync settings schema, defaults and validation.
 *
 * This file is shared between the Electron main process (persistence) and the
 * renderer (UI + visualizer). It must stay free of Node/DOM specific imports.
 *
 * `validateSettings()` never throws: whatever is stored on disk (possibly from an
 * older/newer version or hand-edited) is coerced into a valid Settings object.
 */

export type VisualMode = 'visualizer'
export type ColorMode = 'rainbow' | 'neon' | 'cyanPurple' | 'pinkBlue' | 'fire' | 'ocean' | 'albumArt' | 'custom'
export type FftSize = 1024 | 2048 | 4096 | 8192
/** 0 = uncapped (vsync / requestAnimationFrame rate). */
export type FpsLimit = 0 | 30 | 60 | 120
/**
 * auto    - use the native WASAPI helper, fall back to Chromium loopback if it fails
 * helper  - native WASAPI helper only
 * browser - Chromium system-audio loopback (getDisplayMedia + audio:'loopback') only
 */
export type CaptureEngine = 'auto' | 'helper' | 'browser'
export type FullscreenBehavior = 'remember' | 'always' | 'never'
export type CloseBehavior = 'quit' | 'tray'

export interface GeneralSettings {
  /** Register a Windows "Run" entry. Never enabled without asking the user. */
  startWithWindows: boolean
  startMinimized: boolean
  alwaysOnTop: boolean
  fullscreenBehavior: FullscreenBehavior
  closeBehavior: CloseBehavior
  /** First-run setup dialog was completed. */
  firstRunCompleted: boolean
  lastMode: VisualMode
  /** Opt-in update check on launch (no-op unless an update feed is configured). */
  checkForUpdates: boolean
  /** Hide the overlay chrome in the Visualizer mode after a few idle seconds. */
  autoHideUi: boolean
  /** Prevent display sleep only while the main window is focused. */
  keepScreenAwake: boolean
  /**
   * Render the visualizer on the GPU. Turned off automatically after repeated GPU process
   * crashes (software rendering is slower but always works). Applied at launch.
   */
  hardwareAcceleration: boolean
}

export interface AudioSettings {
  engine: CaptureEngine
  /** WASAPI endpoint id, or null for "Windows default output". */
  deviceId: string | null
  /** Linear gain applied to the analysed signal (0.1 .. 4). */
  sensitivity: number
  fftSize: FftSize
  /** Temporal smoothing of the spectrum bars (0 = none, 0.95 = very slow). */
  smoothing: number
  /** How fast bars fall when the signal drops (0.02 .. 1, fraction per 60 fps frame). */
  decay: number
  peakHold: boolean
  /** Milliseconds a peak marker holds before falling. */
  peakHoldMs: number
  /** dB range mapped onto 0..1. */
  minDb: number
  maxDb: number
}

export interface VisualizerSettings {
  barCount: number
  glow: boolean
  reflection: boolean
  /** Fraction of a bar slot occupied by the bar (0.2 .. 1). */
  barWidth: number
  /** Extra spacing between bars in CSS pixels (0 .. 12). */
  barSpacing: number
  showWaveform: boolean
  particles: boolean
  showAlbumArt: boolean
  fpsLimit: FpsLimit
  showFps: boolean
  /** Rounded bar caps. */
  roundedBars: boolean
  /** Mirror the spectrum around the centre (visualizer mode). */
  mirror: boolean
}

export interface ColorSettings {
  mode: ColorMode
  /** Used by 'custom' and as accent for the UI. */
  primary: string
  secondary: string
  /** 0..1 - how much of the reactive background glow/vignette is shown. */
  backgroundIntensity: number
  /** 0..1 - neon glow / bloom strength. */
  glowStrength: number
}

export interface ShortcutSettings {
  switchVisualizer: string
  toggleFullscreen: string
  exitFullscreen: string
  openSettings: string
  toggleAlwaysOnTop: string
  cycleColorMode: string
  toggleUi: string
}

export interface SpotifySettings {
  showNextTrack: boolean
}

export interface LyricsSettings {
  enabled: boolean
  offsetMs: number
  fontSize: number
  lineGap: number
  opacity: number
  showContext: boolean
}

export interface Settings {
  version: 3
  general: GeneralSettings
  audio: AudioSettings
  visualizer: VisualizerSettings
  colors: ColorSettings
  shortcuts: ShortcutSettings
  lyrics: LyricsSettings
  spotify: SpotifySettings
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[]
    ? U[]
    : T[K] extends object | null
      ? DeepPartial<NonNullable<T[K]>> | null
      : T[K]
}

export const FFT_SIZES: readonly FftSize[] = [1024, 2048, 4096, 8192]
export const FPS_LIMITS: readonly FpsLimit[] = [30, 60, 120, 0]
export const COLOR_MODES: readonly ColorMode[] = [
  'rainbow',
  'neon',
  'cyanPurple',
  'pinkBlue',
  'fire',
  'ocean',
  'albumArt',
  'custom'
]
export const VISUAL_MODES: readonly VisualMode[] = ['visualizer']
export const CAPTURE_ENGINES: readonly CaptureEngine[] = ['auto', 'helper', 'browser']

export const COLOR_MODE_LABELS: Record<ColorMode, string> = {
  rainbow: 'Rainbow',
  neon: 'Neon',
  cyanPurple: 'Cyan / Purple',
  pinkBlue: 'Pink / Blue',
  fire: 'Fire',
  ocean: 'Ocean',
  albumArt: 'Album Art',
  custom: 'Custom'
}

export const VISUAL_MODE_LABELS: Record<VisualMode, string> = {
  visualizer: 'VISUALIZER'
}

export const SETTINGS_LIMITS = {
  sensitivity: { min: 0.1, max: 4, step: 0.05 },
  smoothing: { min: 0, max: 0.95, step: 0.01 },
  decay: { min: 0.02, max: 1, step: 0.01 },
  peakHoldMs: { min: 0, max: 3000, step: 50 },
  minDb: { min: -120, max: -30, step: 1 },
  maxDb: { min: -40, max: 6, step: 1 },
  barCount: { min: 12, max: 160, step: 1 },
  barWidth: { min: 0.2, max: 1, step: 0.01 },
  barSpacing: { min: 0, max: 12, step: 1 },
  backgroundIntensity: { min: 0, max: 1, step: 0.01 },
  glowStrength: { min: 0, max: 1, step: 0.01 }
} as const

export const DEFAULT_SETTINGS: Settings = {
  version: 3,
  general: {
    startWithWindows: false,
    startMinimized: false,
    alwaysOnTop: false,
    fullscreenBehavior: 'remember',
    closeBehavior: 'quit',
    firstRunCompleted: false,
    lastMode: 'visualizer',
    checkForUpdates: true,
    autoHideUi: true,
    keepScreenAwake: true,
    hardwareAcceleration: true
  },
  audio: {
    engine: 'auto',
    deviceId: null,
    sensitivity: 1,
    fftSize: 4096,
    smoothing: 0.6,
    decay: 0.22,
    peakHold: true,
    peakHoldMs: 700,
    minDb: -84,
    maxDb: -12
  },
  visualizer: {
    barCount: 64,
    glow: true,
    reflection: true,
    barWidth: 0.72,
    barSpacing: 2,
    showWaveform: true,
    particles: true,
    showAlbumArt: true,
    fpsLimit: 60,
    showFps: false,
    roundedBars: true,
    mirror: false
  },
  colors: {
    mode: 'neon',
    primary: '#00F0FF',
    secondary: '#B44CFF',
    backgroundIntensity: 0,
    glowStrength: 0.65
  },
  shortcuts: {
    switchVisualizer: 'F3',
    toggleFullscreen: 'F11',
    exitFullscreen: 'Escape',
    openSettings: 'Ctrl+,',
    toggleAlwaysOnTop: 'Ctrl+T',
    cycleColorMode: 'C',
    toggleUi: 'H'
  },
  lyrics: { enabled: true, offsetMs: 0, fontSize: 28, lineGap: 8, opacity: 1, showContext: true },
  spotify: {
    showNextTrack: true
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}

function int(v: unknown, def: number, min: number, max: number): number {
  return Math.round(num(v, def, min, max))
}

function bool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def
}

function oneOf<T extends string | number>(v: unknown, def: T, allowed: readonly T[]): T {
  return (allowed as readonly unknown[]).includes(v) ? (v as T) : def
}

const HEX_COLOR = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/
export function normalizeHexColor(v: unknown, def: string): string {
  if (typeof v !== 'string') return def
  const s = v.trim()
  if (!HEX_COLOR.test(s)) return def
  if (s.length === 4) {
    return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toUpperCase()
  }
  return s.toUpperCase()
}

/**
 * Shortcut strings: optional "Ctrl+", "Shift+", "Alt+" modifiers followed by a
 * key name ("F1".."F24", "Escape", "Space", "Enter", single printable char, arrows).
 */
const SHORTCUT_RE =
  /^(?:(?:Ctrl|Shift|Alt)\+){0,3}(?:F(?:[1-9]|1[0-9]|2[0-4])|Escape|Space|Enter|Tab|Backspace|Delete|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|[A-Za-z0-9`\-=[\];',./\\])$/
export function isValidShortcut(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 32 && SHORTCUT_RE.test(v)
}

function shortcut(v: unknown, def: string): string {
  if (!isValidShortcut(v)) return def
  // Normalise: single letters upper-case, keep modifiers order Ctrl, Shift, Alt.
  const parts = v.split('+')
  const key = parts.pop() as string
  const mods = new Set(parts)
  const out: string[] = []
  if (mods.has('Ctrl')) out.push('Ctrl')
  if (mods.has('Shift')) out.push('Shift')
  if (mods.has('Alt')) out.push('Alt')
  out.push(key.length === 1 ? key.toUpperCase() : key)
  return out.join('+')
}

/**
 * Coerce arbitrary input (disk JSON, IPC patch, older versions) into a valid Settings object.
 * Unknown keys are dropped, invalid values fall back to the supplied base (defaults).
 */
export function validateSettings(input: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const src = isObj(input) ? input : {}
  const g = isObj(src.general) ? src.general : {}
  const a = isObj(src.audio) ? src.audio : {}
  const v = isObj(src.visualizer) ? src.visualizer : {}
  const c = isObj(src.colors) ? src.colors : {}
  const s = isObj(src.shortcuts) ? src.shortcuts : {}
  const ly = isObj(src.lyrics) ? src.lyrics : {}
  const sp = isObj(src.spotify) ? src.spotify : {}
  const L = SETTINGS_LIMITS
  // Upgrade the former default once, without resetting other chosen intensities.
  const legacyBackgroundDefault = (src.version === undefined || src.version === 1) && c.backgroundIntensity === 0.55
  // Before v3 the update toggle was disabled (no feed), so a stored `false` was never a user choice.
  const legacyUpdateDefault = typeof src.version !== 'number' || src.version < 3

  const minDb = num(a.minDb, base.audio.minDb, L.minDb.min, L.minDb.max)
  let maxDb = num(a.maxDb, base.audio.maxDb, L.maxDb.min, L.maxDb.max)
  if (maxDb <= minDb + 6) maxDb = Math.min(L.maxDb.max, minDb + 6)

  const deviceIdRaw = a.deviceId
  const deviceId =
    typeof deviceIdRaw === 'string' && deviceIdRaw.length > 0 && deviceIdRaw.length < 512 ? deviceIdRaw : null

  return {
    version: 3,
    general: {
      startWithWindows: bool(g.startWithWindows, base.general.startWithWindows),
      startMinimized: bool(g.startMinimized, base.general.startMinimized),
      alwaysOnTop: bool(g.alwaysOnTop, base.general.alwaysOnTop),
      fullscreenBehavior: oneOf<FullscreenBehavior>(g.fullscreenBehavior, base.general.fullscreenBehavior, [
        'remember',
        'always',
        'never'
      ]),
      closeBehavior: oneOf<CloseBehavior>(g.closeBehavior, base.general.closeBehavior, ['quit', 'tray']),
      firstRunCompleted: bool(g.firstRunCompleted, base.general.firstRunCompleted),
      lastMode: oneOf<VisualMode>(g.lastMode, base.general.lastMode, VISUAL_MODES),
      checkForUpdates: legacyUpdateDefault ? true : bool(g.checkForUpdates, base.general.checkForUpdates),
      autoHideUi: bool(g.autoHideUi, base.general.autoHideUi),
      keepScreenAwake: bool(g.keepScreenAwake, base.general.keepScreenAwake),
      hardwareAcceleration: bool(g.hardwareAcceleration, base.general.hardwareAcceleration)
    },
    audio: {
      engine: oneOf<CaptureEngine>(a.engine, base.audio.engine, CAPTURE_ENGINES),
      deviceId: 'deviceId' in a ? deviceId : base.audio.deviceId,
      sensitivity: num(a.sensitivity, base.audio.sensitivity, L.sensitivity.min, L.sensitivity.max),
      fftSize: oneOf<FftSize>(a.fftSize, base.audio.fftSize, FFT_SIZES),
      smoothing: num(a.smoothing, base.audio.smoothing, L.smoothing.min, L.smoothing.max),
      decay: num(a.decay, base.audio.decay, L.decay.min, L.decay.max),
      peakHold: bool(a.peakHold, base.audio.peakHold),
      peakHoldMs: int(a.peakHoldMs, base.audio.peakHoldMs, L.peakHoldMs.min, L.peakHoldMs.max),
      minDb,
      maxDb
    },
    visualizer: {
      barCount: int(v.barCount, base.visualizer.barCount, L.barCount.min, L.barCount.max),
      glow: bool(v.glow, base.visualizer.glow),
      reflection: bool(v.reflection, base.visualizer.reflection),
      barWidth: num(v.barWidth, base.visualizer.barWidth, L.barWidth.min, L.barWidth.max),
      barSpacing: num(v.barSpacing, base.visualizer.barSpacing, L.barSpacing.min, L.barSpacing.max),
      showWaveform: bool(v.showWaveform, base.visualizer.showWaveform),
      particles: bool(v.particles, base.visualizer.particles),
      showAlbumArt: bool(v.showAlbumArt, base.visualizer.showAlbumArt),
      fpsLimit: oneOf<FpsLimit>(v.fpsLimit, base.visualizer.fpsLimit, FPS_LIMITS),
      showFps: bool(v.showFps, base.visualizer.showFps),
      roundedBars: bool(v.roundedBars, base.visualizer.roundedBars),
      mirror: bool(v.mirror, base.visualizer.mirror)
    },
    colors: {
      mode: oneOf<ColorMode>(c.mode, base.colors.mode, COLOR_MODES),
      primary: normalizeHexColor(c.primary, base.colors.primary),
      secondary: normalizeHexColor(c.secondary, base.colors.secondary),
      backgroundIntensity: num(
        legacyBackgroundDefault ? 0 : c.backgroundIntensity,
        base.colors.backgroundIntensity,
        L.backgroundIntensity.min,
        L.backgroundIntensity.max
      ),
      glowStrength: num(c.glowStrength, base.colors.glowStrength, L.glowStrength.min, L.glowStrength.max)
    },
    shortcuts: {
      switchVisualizer: shortcut(s.switchVisualizer, base.shortcuts.switchVisualizer),
      toggleFullscreen: shortcut(s.toggleFullscreen, base.shortcuts.toggleFullscreen),
      exitFullscreen: shortcut(s.exitFullscreen, base.shortcuts.exitFullscreen),
      openSettings: shortcut(s.openSettings, base.shortcuts.openSettings),
      toggleAlwaysOnTop: shortcut(s.toggleAlwaysOnTop, base.shortcuts.toggleAlwaysOnTop),
      cycleColorMode: shortcut(s.cycleColorMode, base.shortcuts.cycleColorMode),
      toggleUi: shortcut(s.toggleUi, base.shortcuts.toggleUi)
    },
    lyrics: {
      enabled: bool(ly.enabled, base.lyrics.enabled),
      offsetMs: int(ly.offsetMs, base.lyrics.offsetMs, -10000, 10000),
      fontSize: int(ly.fontSize, base.lyrics.fontSize, 16, 56),
      lineGap: int(ly.lineGap, base.lyrics.lineGap, 0, 24),
      opacity: num(ly.opacity, base.lyrics.opacity, 0.15, 1),
      showContext: bool(ly.showContext, base.lyrics.showContext)
    },
    spotify: {
      showNextTrack: bool(sp.showNextTrack, base.spotify.showNextTrack)
    }
  }
}

/** Deep-merge a partial patch onto existing settings, then validate. */
export function mergeSettings(current: Settings, patch: DeepPartial<Settings>): Settings {
  const merged: Record<string, unknown> = { version: current.version }
  for (const section of ['general', 'audio', 'visualizer', 'colors', 'shortcuts', 'spotify', 'lyrics'] as const) {
    const cur = current[section] as unknown as Record<string, unknown>
    const p = (patch as Record<string, unknown>)[section]
    merged[section] = isObj(p) ? { ...cur, ...p } : { ...cur }
  }
  return validateSettings(merged, current)
}

export function cloneSettings(s: Settings): Settings {
  return JSON.parse(JSON.stringify(s)) as Settings
}
