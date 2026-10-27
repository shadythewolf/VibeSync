/**
 * Right-side settings slide-over with a vertical tab rail. Every control writes through
 * useSettingsStore.update (optimistic) - the main process persists and broadcasts.
 */
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import { IconAudio, IconBars, IconClose, IconInfo, IconKeyboard, IconMusic, IconPalette, IconSliders } from '@renderer/components/icons'
import { IconButton } from '@renderer/components/ui/Button'
import { Kbd } from '@renderer/components/ui/Kbd'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { SETTINGS_TABS, useUiStore, type SettingsTab } from '@renderer/store/uiStore'
import { cx } from '@renderer/utils/classNames'
import { isCapturingShortcut } from '@renderer/utils/shortcuts'
import { AboutTab } from './tabs/AboutTab'
import { AudioTab } from './tabs/AudioTab'
import { ColorsTab } from './tabs/ColorsTab'
import { GeneralTab } from './tabs/GeneralTab'
import { ShortcutsTab } from './tabs/ShortcutsTab'
import { SpotifyTab } from './tabs/SpotifyTab'
import { VisualizerTab } from './tabs/VisualizerTab'

interface TabSpec {
  label: string
  icon: ReactElement
  component: () => ReactElement
}

const TABS: Record<SettingsTab, TabSpec> = {
  general: { label: 'General', icon: <IconSliders />, component: GeneralTab },
  audio: { label: 'Audio', icon: <IconAudio />, component: AudioTab },
  visualizer: { label: 'Visualizer', icon: <IconBars />, component: VisualizerTab },
  colors: { label: 'Colors', icon: <IconPalette />, component: ColorsTab },
  spotify: { label: 'Spotify', icon: <IconMusic />, component: SpotifyTab },
  shortcuts: { label: 'Shortcuts', icon: <IconKeyboard />, component: ShortcutsTab },
  about: { label: 'About', icon: <IconInfo />, component: AboutTab }
}

export function SettingsPanel(): ReactElement {
  const tab = useUiStore((s) => s.settingsTab)
  const openSettings = useUiStore((s) => s.openSettings)
  const closeSettings = useUiStore((s) => s.closeSettings)
  const openCombo = useSettingsStore((s) => s.settings.shortcuts.openSettings)
  const panelRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const previousFocus = useRef<Element | null>(null)

  // Focus management: move focus into the panel on open, restore on close.
  useEffect(() => {
    previousFocus.current = document.activeElement
    closeRef.current?.focus()
    return () => {
      const prev = previousFocus.current
      if (prev instanceof HTMLElement && document.contains(prev)) prev.focus()
    }
  }, [])

  // Escape closes (App.tsx also handles it through the exitFullscreen shortcut; this keeps
  // the panel closable even if that shortcut was remapped).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || isCapturingShortcut()) return
      const target = e.target
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'SELECT') && (target as HTMLInputElement).type === 'color') return
      e.preventDefault()
      closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeSettings])

  const onRailKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    const idx = SETTINGS_TABS.indexOf(tab)
    let next: number | null = null
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (idx + 1) % SETTINGS_TABS.length
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (idx - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = SETTINGS_TABS.length - 1
    if (next === null) return
    e.preventDefault()
    openSettings(SETTINGS_TABS[next])
    const btn = panelRef.current?.querySelector<HTMLButtonElement>(`[data-testid="settings-tab-${SETTINGS_TABS[next]}"]`)
    btn?.focus()
  }

  const Active = TABS[tab].component

  return (
    <div className="settings-root" data-testid="settings-root">
      <div className="settings-backdrop" onClick={closeSettings} aria-hidden="true" />
      <aside
        ref={panelRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        data-testid="settings-panel"
        data-tab={tab}
      >
        <header className="settings-head">
          <div className="settings-head__title">
            <span className="micro-label">VibeSync</span>
            <h2 id="settings-title">Settings</h2>
          </div>
          <div className="row">
            <Kbd combo={openCombo} />
            <IconButton ref={closeRef} label="Close settings" data-testid="settings-close" onClick={closeSettings}>
              <IconClose />
            </IconButton>
          </div>
        </header>

        <div className="settings-body">
          <nav className="settings-rail" role="tablist" aria-orientation="vertical" aria-label="Settings sections" onKeyDown={onRailKeyDown}>
            {SETTINGS_TABS.map((t) => {
              const active = t === tab
              return (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  id={`settings-tab-${t}`}
                  aria-selected={active}
                  aria-controls={`settings-panel-${t}`}
                  tabIndex={active ? 0 : -1}
                  className={cx('settings-tab', active && 'settings-tab--active')}
                  data-testid={`settings-tab-${t}`}
                  onClick={() => openSettings(t)}
                >
                  {TABS[t].icon}
                  <span>{TABS[t].label}</span>
                </button>
              )
            })}
          </nav>
          <section key={tab} id={`settings-panel-${tab}`} role="tabpanel" aria-labelledby={`settings-tab-${tab}`} className="settings-content" tabIndex={0}>
            <Active />
          </section>
        </div>
      </aside>
    </div>
  )
}

export default SettingsPanel
