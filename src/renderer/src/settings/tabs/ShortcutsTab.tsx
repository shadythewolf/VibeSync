import { useEffect, useState, type ReactElement } from 'react'
import { DEFAULT_SETTINGS, isValidShortcut, type DeepPartial, type ShortcutSettings } from '@shared/settings'
import { IconError } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/Button'
import { Kbd } from '@renderer/components/ui/Kbd'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { useUiStore } from '@renderer/store/uiStore'
import { cx } from '@renderer/utils/classNames'
import { beginShortcutCapture, comboFromEvent, normalizeShortcut, shortcutsEqual } from '@renderer/utils/shortcuts'
import { SettingsGroup } from '../SettingRow'

type ShortcutAction = keyof ShortcutSettings

interface ActionSpec {
  key: ShortcutAction
  label: string
  description: string
}

export const SHORTCUT_ACTIONS: readonly ActionSpec[] = [
  { key: 'switchVisualizer', label: 'Visualizer', description: 'Switch to the Visualizer mode.' },
  { key: 'toggleFullscreen', label: 'Toggle fullscreen', description: 'Enter or leave fullscreen.' },
  { key: 'exitFullscreen', label: 'Exit / close', description: 'Close the settings panel, or leave fullscreen.' },
  { key: 'openSettings', label: 'Settings', description: 'Open or close this panel.' },
  { key: 'toggleAlwaysOnTop', label: 'Always on top', description: 'Pin the window above other apps.' },
  { key: 'cycleColorMode', label: 'Cycle colour mode', description: 'Step through the colour palettes.' },
  { key: 'toggleUi', label: 'Hide / show overlay', description: 'Toggle the title bar and overlays.' }
]

export function ShortcutsTab(): ReactElement {
  const shortcuts = useSettingsStore((s) => s.settings.shortcuts)
  const update = useSettingsStore((s) => s.update)
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null)
  const [error, setError] = useState<{ action: ShortcutAction; message: string } | null>(null)

  useEffect(() => {
    if (!capturing) return
    const release = beginShortcutCapture()
    const action = capturing

    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const combo = comboFromEvent(e)
      if (!combo) return // modifier-only press: keep waiting
      if (!isValidShortcut(combo)) {
        setError({ action, message: 'That key cannot be used as a shortcut. Try a letter, digit, F-key, Escape or Space.' })
        return
      }
      const normalized = normalizeShortcut(combo)
      const clash = SHORTCUT_ACTIONS.find((a) => a.key !== action && shortcutsEqual(shortcuts[a.key], normalized))
      if (clash) {
        setError({ action, message: `Already used by "${clash.label}". Choose another key.` })
        return
      }
      const patch: DeepPartial<ShortcutSettings> = {}
      patch[action] = normalized
      update({ shortcuts: patch })
      setError(null)
      setCapturing(null)
    }
    const cancel = (): void => setCapturing(null)

    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', cancel)
    return () => {
      release()
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', cancel)
    }
  }, [capturing, shortcuts, update])

  const resetDefaults = (): void => {
    update({ shortcuts: { ...DEFAULT_SETTINGS.shortcuts } })
    setError(null)
    setCapturing(null)
    useUiStore.getState().pushToast({ kind: 'success', title: 'Shortcuts reset to defaults', timeout: 2500 })
  }

  return (
    <>
      <SettingsGroup title="Key bindings" description="Click Change, then press the new key combination. F-keys, Escape, Space and Ctrl / Shift / Alt combos are allowed.">
        {SHORTCUT_ACTIONS.map((a) => {
          const isCapturing = capturing === a.key
          const rowError = error?.action === a.key ? error.message : null
          const isDefault = shortcutsEqual(shortcuts[a.key], DEFAULT_SETTINGS.shortcuts[a.key])
          return (
            <div key={a.key} className={cx('shortcut-row', isCapturing && 'shortcut-row--capturing')} data-testid={`shortcut-${a.key}`}>
              <div className="shortcut-row__label">
                {a.label}
                <span className="shortcut-row__desc">{rowError ? null : a.description}</span>
                {rowError ? (
                  <span className="inline-error" role="alert">
                    <IconError />
                    {rowError}
                  </span>
                ) : null}
              </div>
              <div className="shortcut-row__keys">
                {isCapturing ? (
                  <>
                    <span className="shortcut-capture" aria-live="polite">
                      Press a key…
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setCapturing(null)
                        setError(null)
                      }}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Kbd combo={shortcuts[a.key]} size="md" accent={!isDefault} />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setError(null)
                        setCapturing(a.key)
                      }}
                      data-testid={`shortcut-change-${a.key}`}
                    >
                      Change
                    </Button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </SettingsGroup>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button size="sm" onClick={resetDefaults} data-testid="shortcuts-reset">
          Reset to defaults
        </Button>
      </div>

      <SettingsGroup title="Quick reference" bare>
        <div className="hint-list">
          {SHORTCUT_ACTIONS.map((action) => (
            <HintRow key={action.key} keys={shortcuts[action.key]} text={action.label} />
          ))}
          <span>Single-key shortcuts pause while you type in a text field.</span>
        </div>
      </SettingsGroup>
    </>
  )
}

function HintRow({ keys, text }: { keys: string; text: string }): ReactElement {
  return (
    <>
      <Kbd combo={keys} size="md" />
      <span>{text}</span>
    </>
  )
}

export default ShortcutsTab
