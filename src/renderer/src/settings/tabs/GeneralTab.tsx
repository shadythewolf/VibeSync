import { useState, type ReactElement } from 'react'
import type { CloseBehavior, FullscreenBehavior } from '@shared/settings'
import { Button } from '@renderer/components/ui/Button'
import { Select } from '@renderer/components/ui/Select'
import { Toggle } from '@renderer/components/ui/Toggle'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { useUiStore } from '@renderer/store/uiStore'
import { errorMessage, getApi } from '@renderer/utils/api'
import { SettingRow, SettingsGroup } from '../SettingRow'
import { useAppInfo } from '../useAppInfo'

const CLOSE_OPTIONS: { value: CloseBehavior; label: string }[] = [
  { value: 'quit', label: 'Quit VibeSync' },
  { value: 'tray', label: 'Keep running in the tray' }
]

const FULLSCREEN_OPTIONS: { value: FullscreenBehavior; label: string }[] = [
  { value: 'remember', label: 'Remember last state' },
  { value: 'always', label: 'Always start fullscreen' },
  { value: 'never', label: 'Never start fullscreen' }
]

export function GeneralTab(): ReactElement {
  const general = useSettingsStore((s) => s.settings.general)
  const update = useSettingsStore((s) => s.update)
  const { info } = useAppInfo()
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)

  const updatesConfigured = info?.updatesConfigured ?? true
  const installed = info ? info.isPackaged && !info.isPortable : true

  const setAlwaysOnTop = (v: boolean): void => {
    update({ general: { alwaysOnTop: v } })
    const api = getApi()
    api?.window.setAlwaysOnTop(v).catch((err: unknown) => api.app.log('warn', 'setAlwaysOnTop failed', String(err)))
  }

  const resetAll = async (): Promise<void> => {
    setResetting(true)
    try {
      await useSettingsStore.getState().reset()
      const s = useSettingsStore.getState().settings
      useUiStore.getState().setMode(s.general.lastMode)
      getApi()?.window.setAlwaysOnTop(s.general.alwaysOnTop).catch(() => undefined)
      useUiStore.getState().pushToast({ kind: 'success', title: 'Settings reset', message: 'Every setting is back to its default.', timeout: 3500 })
    } catch (err) {
      useUiStore.getState().pushToast({ kind: 'error', title: 'Reset failed', message: errorMessage(err), timeout: 6000 })
    } finally {
      setResetting(false)
      setConfirmReset(false)
    }
  }

  return (
    <>
      <SettingsGroup title="Startup">
        <SettingRow
          label="Start with the system"
          description={installed ? 'Starts VibeSync automatically after you sign in.' : 'Only takes effect in the installed app.'}
          htmlFor="general-startWithWindows"
        >
          <Toggle
            id="general-startWithWindows"
            checked={general.startWithWindows}
            onChange={(v) => update({ general: { startWithWindows: v } })}
            data-testid="setting-startWithWindows"
          />
        </SettingRow>
        <SettingRow label="Start minimized" description="Launch to the taskbar / tray without showing the window." htmlFor="general-startMinimized">
          <Toggle
            id="general-startMinimized"
            checked={general.startMinimized}
            onChange={(v) => update({ general: { startMinimized: v } })}
            data-testid="setting-startMinimized"
          />
        </SettingRow>
        <SettingRow label="Fullscreen on launch" description="How the window opens when VibeSync starts.">
          <Select
            aria-label="Fullscreen on launch"
            value={general.fullscreenBehavior}
            options={FULLSCREEN_OPTIONS}
            onChange={(v) => update({ general: { fullscreenBehavior: v } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Window">
        <SettingRow label="Keep screen awake" description="Prevent automatic dimming and sleep only while the VibeSync window has focus." htmlFor="general-keepScreenAwake">
          <Toggle id="general-keepScreenAwake" checked={general.keepScreenAwake} onChange={(v) => update({ general: { keepScreenAwake: v } })} data-testid="setting-keepScreenAwake" />
        </SettingRow>
        <SettingRow label="Always on top" description="Keep VibeSync above other windows (Ctrl+T)." htmlFor="general-alwaysOnTop">
          <Toggle id="general-alwaysOnTop" checked={general.alwaysOnTop} onChange={setAlwaysOnTop} data-testid="setting-alwaysOnTop" />
        </SettingRow>
        <SettingRow label="When closing the window" description="Closing can hide VibeSync to the notification area instead of quitting.">
          <Select
            aria-label="When closing the window"
            value={general.closeBehavior}
            options={CLOSE_OPTIONS}
            onChange={(v) => update({ general: { closeBehavior: v } })}
          />
        </SettingRow>
        <SettingRow
          label="Auto-hide overlay"
          description="Hide the title bar and overlays after 3 seconds without mouse movement in Visualizer mode and in fullscreen."
          htmlFor="general-autoHideUi"
        >
          <Toggle id="general-autoHideUi" checked={general.autoHideUi} onChange={(v) => update({ general: { autoHideUi: v } })} data-testid="setting-autoHideUi" />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Rendering">
        <SettingRow
          label="Hardware acceleration"
          description={
            general.hardwareAcceleration
              ? 'Draws the visualizer on the GPU. Restart VibeSync after changing this.'
              : 'Currently drawing on the CPU. This is slower but survives unstable graphics drivers. Restart VibeSync after changing this.'
          }
          htmlFor="general-hardwareAcceleration"
        >
          <Toggle
            id="general-hardwareAcceleration"
            checked={general.hardwareAcceleration}
            onChange={(v) => update({ general: { hardwareAcceleration: v } })}
            data-testid="setting-hardwareAcceleration"
          />
        </SettingRow>
        {info && !info.hardwareAcceleration ? (
          <p className="note" data-testid="software-rendering-note">
            This session is running in software rendering mode
            {info.gpuFallbackApplied ? ' after repeated graphics driver crashes' : ''}. Expect a lower frame rate.
          </p>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Updates">
        <SettingRow
          label="Check for updates on launch"
          description={
            updatesConfigured
              ? 'Looks for a newer VibeSync once at startup. Nothing is installed without asking.'
              : 'This build has no update feed configured, so update checks are disabled.'
          }
          disabled={!updatesConfigured}
          htmlFor="general-checkForUpdates"
        >
          <Toggle
            id="general-checkForUpdates"
            checked={general.checkForUpdates && updatesConfigured}
            disabled={!updatesConfigured}
            onChange={(v) => update({ general: { checkForUpdates: v } })}
            data-testid="setting-checkForUpdates"
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Danger zone">
        <SettingRow label="Reset all settings" description="Restores every option - audio, visuals, colours and shortcuts - to the defaults." stack={confirmReset}>
          {confirmReset ? (
            <div className="confirm" role="alertdialog" aria-label="Confirm reset">
              <span className="confirm__text">Reset everything to defaults? This cannot be undone.</span>
              <span className="confirm__actions">
                <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)} disabled={resetting}>
                  Cancel
                </Button>
                <Button size="sm" variant="danger" loading={resetting} onClick={() => void resetAll()} data-testid="settings-reset-confirm">
                  Reset
                </Button>
              </span>
            </div>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setConfirmReset(true)} data-testid="settings-reset">
              Reset all settings
            </Button>
          )}
        </SettingRow>
      </SettingsGroup>
    </>
  )
}

export default GeneralTab
