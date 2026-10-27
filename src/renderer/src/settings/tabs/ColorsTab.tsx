import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import { COLOR_MODES, COLOR_MODE_LABELS, SETTINGS_LIMITS, type ColorSettings, type ColorMode } from '@shared/settings'
import { audioEngine } from '@renderer/audio'
import { IconCheck } from '@renderer/components/icons'
import { ColorInput } from '@renderer/components/ui/ColorInput'
import { Slider } from '@renderer/components/ui/Slider'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { useTrackStore } from '@renderer/store/trackStore'
import { cx } from '@renderer/utils/classNames'
import { formatPercent } from '@renderer/utils/format'
import { resolveThemeImmediate } from '@renderer/visualizer/theme'
import { SettingRow, SettingSlot, SettingsGroup } from '../SettingRow'

const PREVIEW_BARS = 32

function paletteGradient(colors: ColorSettings, palette: readonly string[] | null): string {
  const theme = resolveThemeImmediate(colors,palette)
  return `linear-gradient(90deg, ${theme.gradientStops.map(stop => `${stop.color} ${(stop.position*100).toFixed(2)}%`).join(', ')})`
}

/**
 * Live preview: the theme gradient with a mini spectrum driven by the real analysis
 * frame (6 Hz slow subscription, DOM updated directly - no React re-render per update).
 */
function LivePalettePreview(): ReactElement {
  const colors = useSettingsStore((s) => s.settings.colors)
  const artworkPalette = useTrackStore((s) => s.artworkPalette)
  const gradient = useMemo(() => paletteGradient(colors, artworkPalette), [colors, artworkPalette])
  const barsRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = barsRef.current
    if (!host) return
    const els = Array.from(host.children) as HTMLElement[]
    return audioEngine.subscribeSlow((frame) => {
      const n = frame.bars.length
      if (n === 0) return
      for (let i = 0; i < els.length; i++) {
        const idx = Math.min(n - 1, Math.floor((i / els.length) * n))
        const level = frame.bars[idx]
        // Bars are dark masks over the gradient: taller mask = quieter band.
        const h = 100 - Math.max(0, Math.min(1, level)) * 100
        els[i].style.height = h.toFixed(1) + '%'
      }
    }, 12)
  }, [])

  const bars = useMemo(() => Array.from({ length: PREVIEW_BARS }, (_, i) => i), [])
  return (
    <div className="gradient-preview" aria-label="Live colour preview" data-testid="color-preview">
      <div className="gradient-preview__glow" style={{ background: gradient, opacity: 0.35 + 0.45 * colors.glowStrength }} />
      <div className="gradient-preview__bar" style={{ background: gradient }} />
      <div className="gradient-preview__bars" ref={barsRef} aria-hidden="true">
        {bars.map((i) => (
          <span key={i} className="gradient-preview__bar-el" style={{ height: '100%' }} />
        ))}
      </div>
    </div>
  )
}

export function ColorsTab(): ReactElement {
  const colors = useSettingsStore((s) => s.settings.colors)
  const artworkPalette = useTrackStore((s) => s.artworkPalette)
  const update = useSettingsStore((s) => s.update)
  const L = SETTINGS_LIMITS
  const isCustom = colors.mode === 'custom'

  const swatchFor = (mode: ColorMode): string => paletteGradient({ ...colors, mode }, artworkPalette)

  return (
    <>
      <SettingsGroup title="Preview" bare>
        <LivePalettePreview />
      </SettingsGroup>

      <SettingsGroup title="Colour mode" bare>
        <div className="palette-grid" role="radiogroup" aria-label="Colour mode">
          {COLOR_MODES.map((mode) => {
            const active = mode === colors.mode
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={active}
                className={cx('palette-card', active && 'palette-card--active')}
                data-testid={`color-mode-${mode}`}
                onClick={() => update({ colors: { mode } })}
              >
                <span className="palette-card__swatch" style={{ background: swatchFor(mode) }} />
                <span className="palette-card__name">
                  {COLOR_MODE_LABELS[mode]}
                  {active ? <IconCheck className="palette-card__check" /> : null}
                </span>
              </button>
            )
          })}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Custom colours" description={isCustom ? undefined : 'Select the Custom colour mode to edit these.'}>
        <SettingRow label="Primary" description="Low frequencies and the UI accent." disabled={!isCustom}>
          <ColorInput label="Primary colour" value={colors.primary} disabled={!isCustom} onChange={(hex) => update({ colors: { primary: hex } })} />
        </SettingRow>
        <SettingRow label="Secondary" description="High frequencies and highlights." disabled={!isCustom}>
          <ColorInput label="Secondary colour" value={colors.secondary} disabled={!isCustom} onChange={(hex) => update({ colors: { secondary: hex } })} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Atmosphere">
        <SettingSlot>
          <Slider
            label="Background intensity"
            value={colors.backgroundIntensity}
            min={L.backgroundIntensity.min}
            max={L.backgroundIntensity.max}
            step={L.backgroundIntensity.step}
            format={formatPercent}
            onChange={(v) => update({ colors: { backgroundIntensity: v } })}
            description="Optional reactive background glow and vignette. Off by default for a near-black background."
            data-testid="setting-backgroundIntensity"
          />
        </SettingSlot>
        <SettingSlot>
          <Slider
            label="Glow strength"
            value={colors.glowStrength}
            min={L.glowStrength.min}
            max={L.glowStrength.max}
            step={L.glowStrength.step}
            format={formatPercent}
            onChange={(v) => update({ colors: { glowStrength: v } })}
            description="Neon bloom around bars, rings and text."
            data-testid="setting-glowStrength"
          />
        </SettingSlot>
      </SettingsGroup>
    </>
  )
}

export default ColorsTab
