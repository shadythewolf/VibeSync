import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  cloneSettings,
  isValidShortcut,
  mergeSettings,
  normalizeHexColor,
  validateSettings
} from '../../src/shared/settings'

describe('validateSettings', () => {
  it('upgrades the former background default once and preserves custom intensities', () => {
    const old = { version: 1, colors: { backgroundIntensity: 0.55, mode: 'albumArt', glowStrength: 0.8 }, lyrics: { offsetMs: 750 }, spotify: { showNextTrack: false } }
    const migrated = validateSettings(old)
    expect(migrated.colors).toMatchObject({ backgroundIntensity: 0, mode: 'albumArt', glowStrength: 0.8 })
    expect(migrated.lyrics.offsetMs).toBe(750)
    expect(migrated.spotify.showNextTrack).toBe(false)
    expect(validateSettings({version: 1, colors:{backgroundIntensity:0.3}}).colors.backgroundIntensity).toBe(0.3)
    const chosen = mergeSettings(migrated, {colors:{backgroundIntensity:0.55}})
    expect(validateSettings(JSON.parse(JSON.stringify(chosen))).colors.backgroundIntensity).toBe(0.55)
    expect(mergeSettings(chosen, {lyrics:{fontSize:32}}).colors.backgroundIntensity).toBe(0.55)
  })
  it('enables focused wake protection for older profiles and preserves an explicit opt-out', () => {
    expect(validateSettings({ general: {} }).general.keepScreenAwake).toBe(true)
    expect(validateSettings({ general: { keepScreenAwake: false } }).general.keepScreenAwake).toBe(false)
    expect(mergeSettings(cloneSettings(DEFAULT_SETTINGS), { general: { keepScreenAwake: false } }).general.keepScreenAwake).toBe(false)
  })
  it('maps former DJ modes to visualizer without losing fork features', () => {
    for (const oldMode of ['neon', 'pro']) {
      const s = validateSettings({ general: { lastMode: oldMode }, colors: { mode: 'albumArt' },
        lyrics: { enabled: true, offsetMs: 250 }, spotify: { clientId: 'AbC123456' },
        shortcuts: { switchNeon: 'F1', switchPro: 'F2' } })
      expect(s.general.lastMode).toBe('visualizer')
      expect(s.colors.mode).toBe('albumArt')
      expect(s.lyrics.offsetMs).toBe(250)
      expect(s.spotify).not.toHaveProperty('clientId')
      expect(s.shortcuts).not.toHaveProperty('switchNeon')
      expect(s.shortcuts).not.toHaveProperty('switchPro')
    }
  })
  it('drops obsolete OAuth fields while preserving queue and lyrics settings', () => {
    const settings = validateSettings({spotify:{clientId:'AbC123456',showNextTrack:false},lyrics:{offsetMs:500}})
    expect(settings.spotify).toEqual({showNextTrack:false})
    expect(settings.lyrics.offsetMs).toBe(500)
  })
  it('returns defaults for garbage input', () => {
    for (const input of [null, undefined, 42, 'nope', [], true]) {
      expect(validateSettings(input)).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('never throws and returns a fresh object', () => {
    const out = validateSettings({})
    expect(out).toEqual(DEFAULT_SETTINGS)
    expect(out).not.toBe(DEFAULT_SETTINGS)
    expect(out.audio).not.toBe(DEFAULT_SETTINGS.audio)
  })

  it('clamps numeric ranges', () => {
    const s = validateSettings({
      audio: { sensitivity: 99, smoothing: 2, decay: -1, peakHoldMs: 99999 },
      visualizer: { barCount: 5, barWidth: 7, barSpacing: -3 },
      colors: { backgroundIntensity: 3, glowStrength: -1 }
    })
    expect(s.audio.sensitivity).toBe(4)
    expect(s.audio.smoothing).toBe(0.95)
    expect(s.audio.decay).toBe(0.02)
    expect(s.audio.peakHoldMs).toBe(3000)
    expect(s.visualizer.barCount).toBe(12)
    expect(s.visualizer.barWidth).toBe(1)
    expect(s.visualizer.barSpacing).toBe(0)
    expect(s.colors.backgroundIntensity).toBe(1)
    expect(s.colors.glowStrength).toBe(0)
    expect(validateSettings({ visualizer: { barCount: 1000 } }).visualizer.barCount).toBe(160)
    expect(validateSettings({ visualizer: { barCount: 47.6 } }).visualizer.barCount).toBe(48)
  })

  it('accepts numeric strings but rejects NaN / non-numbers', () => {
    expect(validateSettings({ audio: { sensitivity: '2.5' } }).audio.sensitivity).toBe(2.5)
    expect(validateSettings({ audio: { sensitivity: 'abc' } }).audio.sensitivity).toBe(DEFAULT_SETTINGS.audio.sensitivity)
    expect(validateSettings({ audio: { sensitivity: NaN } }).audio.sensitivity).toBe(DEFAULT_SETTINGS.audio.sensitivity)
    expect(validateSettings({ audio: { sensitivity: {} } }).audio.sensitivity).toBe(DEFAULT_SETTINGS.audio.sensitivity)
  })

  it('falls back for enum values that are not allowed', () => {
    const s = validateSettings({
      audio: { engine: 'magic', fftSize: 3000 },
      visualizer: { fpsLimit: 45 },
      colors: { mode: 'sepia' },
      general: { lastMode: 'disco', fullscreenBehavior: 'maybe', closeBehavior: 'explode' }
    })
    expect(s.audio.engine).toBe('auto')
    expect(s.audio.fftSize).toBe(4096)
    expect(s.visualizer.fpsLimit).toBe(60)
    expect(s.colors.mode).toBe('neon')
    expect(s.general.lastMode).toBe('visualizer')
    expect(s.general.fullscreenBehavior).toBe('remember')
    expect(s.general.closeBehavior).toBe('quit')
    expect(validateSettings({ audio: { fftSize: 8192 } }).audio.fftSize).toBe(8192)
    expect(validateSettings({ visualizer: { fpsLimit: 0 } }).visualizer.fpsLimit).toBe(0)
    expect(validateSettings({ colors: { mode: 'albumArt' } }).colors.mode).toBe('albumArt')
  })

  it('keeps maxDb at least 6 dB above minDb', () => {
    const s = validateSettings({ audio: { minDb: -30, maxDb: -40 } })
    expect(s.audio.minDb).toBe(-30)
    expect(s.audio.maxDb).toBe(-24)
    const t = validateSettings({ audio: { minDb: -500, maxDb: 500 } })
    expect(t.audio.minDb).toBe(-120)
    expect(t.audio.maxDb).toBe(6)
  })

  it('validates and normalises colours', () => {
    const s = validateSettings({ colors: { primary: 'red', secondary: '#0f0' } })
    expect(s.colors.primary).toBe(DEFAULT_SETTINGS.colors.primary)
    expect(s.colors.secondary).toBe('#00FF00')
    expect(validateSettings({ colors: { primary: '#abcdef' } }).colors.primary).toBe('#ABCDEF')
    expect(validateSettings({ colors: { primary: '#abcde' } }).colors.primary).toBe(DEFAULT_SETTINGS.colors.primary)
    expect(validateSettings({ colors: { primary: 'javascript:alert(1)' } }).colors.primary).toBe(DEFAULT_SETTINGS.colors.primary)
    expect(normalizeHexColor('  #ABC ', '#000000')).toBe('#AABBCC')
    expect(normalizeHexColor(123, '#000000')).toBe('#000000')
  })

  it('rejects bad shortcuts and normalises good ones', () => {
    const s = validateSettings({
      shortcuts: {
        switchVisualizer: 'ctrl+a',
        toggleFullscreen: 'F13',
        exitFullscreen: 'Alt+Shift+Ctrl+q',
        openSettings: 'Ctrl+',
        toggleAlwaysOnTop: 'Ctrl+Ctrl+Ctrl+Ctrl+T',
        cycleColorMode: 'x',
        toggleUi: 'Delete'
      }
    })
    expect(s.shortcuts.switchVisualizer).toBe(DEFAULT_SETTINGS.shortcuts.switchVisualizer)
    expect(s.shortcuts.toggleFullscreen).toBe('F13')
    expect(s.shortcuts.exitFullscreen).toBe('Ctrl+Shift+Alt+Q')
    expect(s.shortcuts.openSettings).toBe(DEFAULT_SETTINGS.shortcuts.openSettings)
    expect(s.shortcuts.toggleAlwaysOnTop).toBe(DEFAULT_SETTINGS.shortcuts.toggleAlwaysOnTop)
    expect(s.shortcuts.cycleColorMode).toBe('X')
    expect(s.shortcuts.toggleUi).toBe('Delete')
    expect(isValidShortcut('F25')).toBe(false)
    expect(isValidShortcut('Ctrl+,')).toBe(true)
    expect(isValidShortcut(42)).toBe(false)
  })

  it('handles deviceId: strings are kept, everything else becomes null, absence keeps the base', () => {
    expect(validateSettings({ audio: { deviceId: '{0.0.0.00000000}.{abc}' } }).audio.deviceId).toBe('{0.0.0.00000000}.{abc}')
    expect(validateSettings({ audio: { deviceId: 12 } }).audio.deviceId).toBeNull()
    expect(validateSettings({ audio: { deviceId: '' } }).audio.deviceId).toBeNull()
    const base = cloneSettings(DEFAULT_SETTINGS)
    base.audio.deviceId = 'keep-me'
    expect(validateSettings({ audio: { sensitivity: 1 } }, base).audio.deviceId).toBe('keep-me')
    expect(validateSettings({ audio: { deviceId: null } }, base).audio.deviceId).toBeNull()
  })

  it('drops unknown keys and forces the current schema version', () => {
    const out = validateSettings({ version: 7, general: { foo: 1 }, bogus: true }) as unknown as Record<string, unknown>
    expect(out.version).toBe(3)
    expect(out.bogus).toBeUndefined()
    expect((out.general as Record<string, unknown>).foo).toBeUndefined()
  })

  it('turns update checks on once for profiles from before the update feed', () => {
    expect(validateSettings({ version: 2, general: { checkForUpdates: false } }).general.checkForUpdates).toBe(true)
    expect(validateSettings({ general: { checkForUpdates: false } }).general.checkForUpdates).toBe(true)
  })

  it('keeps a user choice to disable update checks', () => {
    expect(validateSettings({ version: 3, general: { checkForUpdates: false } }).general.checkForUpdates).toBe(false)
    expect(DEFAULT_SETTINGS.general.checkForUpdates).toBe(true)
  })
})

describe('mergeSettings', () => {
  it('deep merges a partial patch and keeps untouched fields', () => {
    const cur = cloneSettings(DEFAULT_SETTINGS)
    cur.audio.deviceId = 'dev-1'
    const next = mergeSettings(cur, { audio: { sensitivity: 2 }, colors: { mode: 'fire' } })
    expect(next.audio.sensitivity).toBe(2)
    expect(next.audio.deviceId).toBe('dev-1')
    expect(next.audio.fftSize).toBe(cur.audio.fftSize)
    expect(next.colors.mode).toBe('fire')
    expect(next.colors.primary).toBe(cur.colors.primary)
    expect(next.general).toEqual(cur.general)
    expect(next).not.toBe(cur)
    expect(cur.audio.sensitivity).toBe(1) // input not mutated
  })

  it('validates the patch against the current settings (not the defaults)', () => {
    const cur = cloneSettings(DEFAULT_SETTINGS)
    cur.audio.fftSize = 8192
    cur.visualizer.barCount = 96
    const next = mergeSettings(cur, { audio: { fftSize: 999 as unknown as 4096 }, visualizer: { barCount: NaN } })
    expect(next.audio.fftSize).toBe(8192)
    expect(next.visualizer.barCount).toBe(96)
  })

  it('ignores null / non-object sections and unknown keys', () => {
    const cur = cloneSettings(DEFAULT_SETTINGS)
    const next = mergeSettings(cur, { audio: null, shortcuts: { toggleUi: 'Space' } } as never)
    expect(next.audio).toEqual(cur.audio)
    expect(next.shortcuts.toggleUi).toBe('Space')
  })

  it('cloneSettings produces an independent deep copy', () => {
    const a = cloneSettings(DEFAULT_SETTINGS)
    a.colors.primary = '#123456'
    expect(DEFAULT_SETTINGS.colors.primary).not.toBe('#123456')
  })
})
