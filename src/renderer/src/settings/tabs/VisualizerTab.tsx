import type { ReactElement } from 'react'
import { FPS_LIMITS, SETTINGS_LIMITS, type DeepPartial, type FpsLimit, type VisualizerSettings } from '@shared/settings'
import { SegmentedControl } from '@renderer/components/ui/SegmentedControl'
import { Slider } from '@renderer/components/ui/Slider'
import { Toggle } from '@renderer/components/ui/Toggle'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { formatPercent } from '@renderer/utils/format'
import { SettingRow, SettingSlot, SettingsGroup } from '../SettingRow'

type BoolKey = { [K in keyof VisualizerSettings]: VisualizerSettings[K] extends boolean ? K : never }[keyof VisualizerSettings]

interface ToggleSpec {
  key: BoolKey
  label: string
  description: string
}

const LOOK_TOGGLES: ToggleSpec[] = [
  { key: 'roundedBars', label: 'Rounded bars', description: 'Soft capsule caps instead of flat tops.' },
  { key: 'glow', label: 'Glow', description: 'Neon bloom around bars and accents.' },
  { key: 'reflection', label: 'Reflection', description: 'Mirrored fade-out below the spectrum.' },
  { key: 'mirror', label: 'Mirror', description: 'Mirror the spectrum around the centre.' }
]

const LAYER_TOGGLES: ToggleSpec[] = [
  { key: 'showWaveform', label: 'Waveform', description: 'Oscilloscope trace of the live signal.' },
  { key: 'particles', label: 'Particles', description: 'Beat-driven particle bursts.' },
  { key: 'showAlbumArt', label: 'Album art', description: 'Show artwork from the Windows media session when available.' }
]

const FPS_LABEL: Record<FpsLimit, string> = { 30: '30', 60: '60', 120: '120', 0: 'Unlimited' }

export function VisualizerTab(): ReactElement {
  const visualizer = useSettingsStore((s) => s.settings.visualizer)
  const update = useSettingsStore((s) => s.update)
  const L = SETTINGS_LIMITS

  const setFlag = (key: BoolKey, v: boolean): void => {
    const patch: DeepPartial<VisualizerSettings> = {}
    patch[key] = v
    update({ visualizer: patch })
  }

  const renderToggle = (t: ToggleSpec): ReactElement => (
    <SettingRow key={t.key} label={t.label} description={t.description} htmlFor={`visualizer-${t.key}`}>
      <Toggle id={`visualizer-${t.key}`} checked={visualizer[t.key]} onChange={(v) => setFlag(t.key, v)} data-testid={`setting-${t.key}`} />
    </SettingRow>
  )

  return (
    <>
      <SettingsGroup title="Spectrum">
        <SettingSlot>
          <Slider
            label="Bar count"
            value={visualizer.barCount}
            min={L.barCount.min}
            max={L.barCount.max}
            step={L.barCount.step}
            onChange={(v) => update({ visualizer: { barCount: Math.round(v) } })}
            description="Log-spaced bands from 20 Hz to 20 kHz."
            data-testid="setting-barCount"
          />
        </SettingSlot>
        <SettingSlot>
          <Slider
            label="Bar width"
            value={visualizer.barWidth}
            min={L.barWidth.min}
            max={L.barWidth.max}
            step={L.barWidth.step}
            format={formatPercent}
            onChange={(v) => update({ visualizer: { barWidth: v } })}
            description="How much of each slot the bar fills."
            data-testid="setting-barWidth"
          />
        </SettingSlot>
        <SettingSlot>
          <Slider
            label="Bar spacing"
            value={visualizer.barSpacing}
            min={L.barSpacing.min}
            max={L.barSpacing.max}
            step={L.barSpacing.step}
            format={(v) => `${Math.round(v)} px`}
            onChange={(v) => update({ visualizer: { barSpacing: Math.round(v) } })}
            data-testid="setting-barSpacing"
          />
        </SettingSlot>
      </SettingsGroup>

      <SettingsGroup title="Look">{LOOK_TOGGLES.map(renderToggle)}</SettingsGroup>

      <SettingsGroup title="Layers">{LAYER_TOGGLES.map(renderToggle)}</SettingsGroup>

      <SettingsGroup title="Performance">
        <SettingRow label="FPS limit" description="Cap the render loop. Unlimited follows your display refresh rate." stack>
          <SegmentedControl<FpsLimit>
            label="FPS limit"
            value={visualizer.fpsLimit}
            options={FPS_LIMITS.map((f) => ({ value: f, label: FPS_LABEL[f], 'data-testid': `setting-fpsLimit-${f}` }))}
            onChange={(v) => update({ visualizer: { fpsLimit: v } })}
            block
            accent
          />
        </SettingRow>
        <SettingRow label="Show FPS" description="Render a small frame-rate counter." htmlFor="visualizer-showFps">
          <Toggle id="visualizer-showFps" checked={visualizer.showFps} onChange={(v) => update({ visualizer: { showFps: v } })} data-testid="setting-showFps" />
        </SettingRow>
      </SettingsGroup>
    </>
  )
}

export default VisualizerTab
