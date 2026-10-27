/**
 * Application shell: title bar, the active visual mode, banners, settings, toasts and
 * the first-run dialog. Also owns global keyboard shortcuts, fullscreen chrome
 * behaviour and the idle auto-hide of the overlay UI.
 *
 * Switching modes only swaps the mounted mode component; the audio engine and the frame
 * scheduler are singletons that keep running untouched.
 */
import { useEffect, useLayoutEffect, useState, type ReactElement } from 'react'
import { COLOR_MODES, COLOR_MODE_LABELS } from '@shared/settings'
import { AudioErrorBanner } from './components/AudioErrorBanner'
import { ErrorBoundary, ErrorScreen } from './components/ErrorBoundary'
import { FirstRunDialog } from './components/FirstRunDialog'
import { TitleBar, toggleAlwaysOnTop, toggleFullscreen } from './components/TitleBar'
import { Toasts } from './components/Toasts'
import { MODE_COMPONENTS } from './modes'
import { SettingsPanel } from './settings/SettingsPanel'
import { getSettings, useSettingsStore } from './store/settingsStore'
import { useTrackStore } from './store/trackStore'
import { useUiStore } from './store/uiStore'
import { errorMessage, getApi } from './utils/api'
import { cx } from './utils/classNames'
import { isCapturingShortcut, shouldHandleShortcut } from './utils/shortcuts'
import { applyThemeCssVars } from './utils/theme'

/** Fullscreen: the floating title bar hides after this long without pointer movement. */
const FULLSCREEN_BAR_IDLE_MS = 2500
/** Auto-hide overlay (Visualizer mode / fullscreen) after this long without pointer movement. */
const AUTO_HIDE_IDLE_MS = 3000
/** Elements that keep the chrome visible while hovered. */
const HOLD_SELECTOR = '.titlebar:hover, .audio-banner:hover, .toasts:hover'
const COLOR_MODE_TOAST_ID = 9002

const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'wheel']

/**
 * True while the pointer moved within `idleMs`. Listens passively; state only changes on
 * the active <-> idle transitions so React is not touched per mouse event.
 */
function usePointerActivity(enabled: boolean, idleMs: number): boolean {
  const [active, setActive] = useState(false)
  useEffect(() => {
    if (!enabled) {
      setActive(false)
      return
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    let isActive = false
    const goIdle = (): void => {
      timer = null
      if (document.querySelector(HOLD_SELECTOR)) {
        timer = setTimeout(goIdle, idleMs)
        return
      }
      isActive = false
      setActive(false)
    }
    const bump = (): void => {
      if (!isActive) {
        isActive = true
        setActive(true)
      }
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(goIdle, idleMs)
    }
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, bump, { passive: true })
    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, bump)
      if (timer !== null) clearTimeout(timer)
    }
  }, [enabled, idleMs])
  return active
}

/** Hides the overlay chrome after `idleMs` without pointer movement; any movement reveals it. */
function useAutoHideUi(enabled: boolean, idleMs: number): void {
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let autoHidden = false
    const hide = (): void => {
      timer = null
      if (document.querySelector(HOLD_SELECTOR)) {
        timer = setTimeout(hide, idleMs)
        return
      }
      autoHidden = true
      useUiStore.getState().setUiHidden(true)
    }
    const arm = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(hide, idleMs)
    }
    const onActivity = (): void => {
      const ui = useUiStore.getState()
      if (ui.uiHidden) {
        autoHidden = false
        ui.setUiHidden(false)
      }
      arm()
    }
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onActivity, { passive: true })
    arm()
    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity)
      if (timer !== null) clearTimeout(timer)
      if (autoHidden) useUiStore.getState().setUiHidden(false)
    }
  }, [enabled, idleMs])
}

function exitFullscreen(): void {
  const api = getApi()
  if (!api) return
  api.window.setFullscreen(false).catch((err: unknown) => api.app.log('warn', 'setFullscreen(false) failed', String(err)))
}

function cycleColorMode(): void {
  const { settings, update } = useSettingsStore.getState()
  const i = COLOR_MODES.indexOf(settings.colors.mode)
  const next = COLOR_MODES[(i + 1) % COLOR_MODES.length]
  update({ colors: { mode: next } })
  useUiStore.getState().pushToast({ id: COLOR_MODE_TOAST_ID, kind: 'info', title: `Colour mode: ${COLOR_MODE_LABELS[next]}`, timeout: 1500 })
}

/** One capture-phase keydown listener for every configurable shortcut. */
function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat || isCapturingShortcut()) return
      const { shortcuts } = getSettings()
      const ui = useUiStore.getState()

      /** Runs `action` when the combo matches; the action returns false to leave the event alone. */
      const handle = (combo: string, action: () => boolean | void): boolean => {
        if (!shouldHandleShortcut(e, combo)) return false
        const handled = action() !== false
        if (handled) {
          e.preventDefault()
          e.stopPropagation()
        }
        return handled
      }

      if (
        handle(shortcuts.exitFullscreen, () => {
          if (ui.settingsOpen) {
            ui.closeSettings()
            return true
          }
          if (ui.fullscreen) {
            exitFullscreen()
            return true
          }
          return false
        })
      ) {
        return
      }
      if (handle(shortcuts.switchVisualizer, () => ui.setMode('visualizer'))) return
      if (handle(shortcuts.toggleFullscreen, () => toggleFullscreen())) return
      if (handle(shortcuts.openSettings, () => ui.toggleSettings())) return
      if (handle(shortcuts.toggleAlwaysOnTop, () => toggleAlwaysOnTop())) return
      if (ui.firstRunOpen) return
      if (handle(shortcuts.cycleColorMode, () => cycleColorMode())) return
      handle(shortcuts.toggleUi, () => ui.setUiHidden(!ui.uiHidden))
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}

function Stage({ mode }: { mode: keyof typeof MODE_COMPONENTS }): ReactElement {
  const ModeComponent = MODE_COMPONENTS[mode]
  return (
    <main className="app__stage" data-testid="stage" data-mode={mode}>
      <ErrorBoundary resetKey={mode} source={`mode:${mode}`} title="This visual mode crashed" allowRetry>
        <ModeComponent />
      </ErrorBoundary>
    </main>
  )
}

export function App(): ReactElement {
  const mode = useUiStore((s) => s.mode)
  const settingsOpen = useUiStore((s) => s.settingsOpen)
  const firstRunOpen = useUiStore((s) => s.firstRunOpen)
  const fullscreen = useUiStore((s) => s.fullscreen)
  const uiHidden = useUiStore((s) => s.uiHidden)
  const fatalError = useUiStore((s) => s.fatalError)
  const colors = useSettingsStore((s) => s.settings.colors)
  const artworkPalette = useTrackStore((s) => s.artworkPalette)
  const autoHideUi = useSettingsStore((s) => s.settings.general.autoHideUi)

  // Theme accent -> CSS variables for the whole chrome.
  useLayoutEffect(() => {
    applyThemeCssVars(colors, artworkPalette)
  }, [colors, artworkPalette])

  useGlobalShortcuts()

  const barVisible = usePointerActivity(fullscreen, FULLSCREEN_BAR_IDLE_MS)
  useAutoHideUi(autoHideUi && (mode === 'visualizer' || fullscreen) && !settingsOpen && !firstRunOpen, AUTO_HIDE_IDLE_MS)

  // Never leave the UI hidden while a dialog needs attention.
  useEffect(() => {
    if ((settingsOpen || firstRunOpen) && useUiStore.getState().uiHidden) useUiStore.getState().setUiHidden(false)
  }, [settingsOpen, firstRunOpen])

  useEffect(() => {
    document.documentElement.dataset.mode = mode
  }, [mode])

  if (fatalError) {
    return (
      <div className="app" data-testid="app-root" data-mode={mode} data-fatal="true">
        <ErrorScreen
          title="VibeSync could not start"
          message={fatalError}
          onReload={() => location.reload()}
        />
      </div>
    )
  }

  return (
    <ErrorBoundary
      source="App"
      title="VibeSync ran into a problem"
      onError={(err) => getApi()?.app.log('error', 'App render error', errorMessage(err))}
    >
      <div
        className={cx('app', fullscreen && 'app--fullscreen', uiHidden && 'app--ui-hidden', settingsOpen && 'app--settings-open')}
        data-testid="app-root"
        data-mode={mode}
        data-fullscreen={fullscreen ? 'true' : 'false'}
        data-ui-hidden={uiHidden ? 'true' : 'false'}
      >
        <TitleBar floating={fullscreen} visible={!fullscreen || barVisible} />
        <Stage mode={mode} />
        <AudioErrorBanner />
        {settingsOpen ? <SettingsPanel /> : null}
        <Toasts />
        {firstRunOpen ? <FirstRunDialog /> : null}
      </div>
    </ErrorBoundary>
  )
}

export default App
