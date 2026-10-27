/**
 * 40 px frameless-window title bar. The whole bar is a drag region; interactive controls
 * opt out with `no-drag`. The right edge keeps a 138 px spacer so the native Windows
 * caption buttons (BrowserWindow titleBarOverlay) never overlap our controls.
 * In fullscreen App.tsx renders it as a floating compact bar (`floating`).
 */
import type { ReactElement } from 'react'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { useUiStore } from '@renderer/store/uiStore'
import { getApi } from '@renderer/utils/api'
import { cx } from '@renderer/utils/classNames'
import { formatShortcut } from '@renderer/utils/shortcuts'
import { AudioStatusBadge } from './AudioStatusBadge'
import { IconExitFullscreen, IconFullscreen, IconPin, IconSettings } from './icons'
import { Logo } from './Logo'
import { IconButton } from './ui/Button'

export interface TitleBarProps {
  /** Compact floating variant used in fullscreen. */
  floating?: boolean
  /** Visibility (fullscreen only - controls the slide animation). */
  visible?: boolean
}

export function toggleAlwaysOnTop(): void {
  const { settings, update } = useSettingsStore.getState()
  const next = !settings.general.alwaysOnTop
  update({ general: { alwaysOnTop: next } })
  const api = getApi()
  if (api) {
    api.window.setAlwaysOnTop(next).catch((err: unknown) => {
      api.app.log('warn', 'setAlwaysOnTop failed', String(err))
    })
  }
}

export function toggleFullscreen(): void {
  const api = getApi()
  if (!api) return
  api.window.toggleFullscreen().catch((err: unknown) => {
    api.app.log('warn', 'toggleFullscreen failed', String(err))
    useUiStore.getState().pushToast({ kind: 'error', title: 'Could not toggle fullscreen', message: String(err), timeout: 4000 })
  })
}

export function TitleBar({ floating = false, visible = true }: TitleBarProps): ReactElement {
  const alwaysOnTop = useSettingsStore((s) => s.settings.general.alwaysOnTop)
  const shortcuts = useSettingsStore((s) => s.settings.shortcuts)
  const fullscreen = useUiStore((s) => s.fullscreen)
  const settingsOpen = useUiStore((s) => s.settingsOpen)
  const toggleSettings = useUiStore((s) => s.toggleSettings)

  return (
    <header
      className={cx('titlebar', 'drag-region', floating && 'titlebar--floating', visible && 'titlebar--visible')}
      data-testid="titlebar"
      aria-hidden={!visible || undefined}
    >
      <div className="titlebar__left">
        <Logo size={20} />
        <span className="titlebar__wordmark">
          Vibe<span>Sync</span>
        </span>
      </div>

      <div className="titlebar__center">
        <span className="micro-label">VISUALIZER</span>
      </div>

      <div className="titlebar__right no-drag">
        <AudioStatusBadge />
        <span className="titlebar__divider" aria-hidden="true" />
        <IconButton
          label={alwaysOnTop ? 'Always on top: on' : 'Always on top: off'}
          title={`Always on top (${formatShortcut(shortcuts.toggleAlwaysOnTop)})`}
          active={alwaysOnTop}
          aria-pressed={alwaysOnTop}
          data-testid="always-on-top-toggle"
          data-active={alwaysOnTop ? 'true' : 'false'}
          onClick={toggleAlwaysOnTop}
        >
          <IconPin />
        </IconButton>
        <IconButton
          label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          title={`${fullscreen ? 'Exit' : 'Enter'} fullscreen (${formatShortcut(shortcuts.toggleFullscreen)})`}
          data-testid="fullscreen-button"
          aria-pressed={fullscreen}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <IconExitFullscreen /> : <IconFullscreen />}
        </IconButton>
        <IconButton
          label="Settings"
          title={`Settings (${formatShortcut(shortcuts.openSettings)})`}
          data-testid="settings-button"
          active={settingsOpen}
          aria-expanded={settingsOpen}
          aria-haspopup="dialog"
          onClick={toggleSettings}
        >
          <IconSettings />
        </IconButton>
        <div className="titlebar__caption-spacer" aria-hidden="true" />
      </div>
    </header>
  )
}

export default TitleBar
