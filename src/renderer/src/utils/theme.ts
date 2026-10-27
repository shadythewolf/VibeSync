/**
 * Bridges the visualizer colour theme into CSS custom properties so the React chrome
 * (title bar, mode selector, settings, toasts) glows in the same colours as the canvas.
 * `applyThemeCssVars()` is called from App.tsx whenever `settings.colors` changes.
 */
import type { CSSProperties } from 'react'
import type { ColorSettings } from '@shared/settings'
import { hexToRgb, luminance, resolveThemeImmediate, rgbToHex, withAlpha } from '@renderer/visualizer/theme'

/** CSSProperties that also accepts `--custom-property` keys. */
export type CssVarStyle = CSSProperties & { [key: `--${string}`]: string | number }

export type ThemeCssVars = Record<`--${string}`, string>

const MIN_ALBUM_ART_UI_LUMINANCE = 0.48

function rgbTriplet(hex: string): string {
  const { r, g, b } = hexToRgb(hex)
  return `${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}`
}

/** Keep album-derived menu accents legible without changing the visualizer palette itself. */
export function readableAlbumArtAccent(hex: string): string {
  const current = luminance(hex)
  if (current >= MIN_ALBUM_ART_UI_LUMINANCE) return hex
  const amount = (MIN_ALBUM_ART_UI_LUMINANCE - current) / (1 - current)
  const color = hexToRgb(hex)
  return rgbToHex({
    r: color.r + (255 - color.r) * amount,
    g: color.g + (255 - color.g) * amount,
    b: color.b + (255 - color.b) * amount
  })
}

export function themeCssVars(colors: ColorSettings, artworkPalette: readonly string[] | null = null): ThemeCssVars {
  const theme = resolveThemeImmediate(colors, artworkPalette)
  const glowAlpha = 0.22 + 0.4 * theme.glowStrength
  const uiStops = colors.mode === 'albumArt' ? theme.stops.map(readableAlbumArtAccent) : theme.stops
  const primary = uiStops[0]
  const secondary = uiStops[uiStops.length - 1]
  const accent = uiStops[Math.floor(uiStops.length / 2)]
  const stops = theme.gradientStops.map(stop => {
    const color = colors.mode === 'albumArt' ? readableAlbumArtAccent(stop.color) : stop.color
    return `${color} ${(stop.position * 100).toFixed(2)}%`
  }).join(', ')
  return {
    '--accent': primary,
    '--accent-2': secondary,
    '--accent-3': accent,
    '--accent-rgb': rgbTriplet(primary),
    '--accent-2-rgb': rgbTriplet(secondary),
    '--accent-glow': withAlpha(primary, glowAlpha),
    '--accent-2-glow': withAlpha(secondary, glowAlpha),
    '--accent-soft': withAlpha(primary, 0.12),
    '--accent-softer': withAlpha(primary, 0.06),
    '--accent-border': withAlpha(primary, 0.38),
    '--accent-2-soft': withAlpha(secondary, 0.14),
    '--theme-gradient': `linear-gradient(90deg, ${stops})`,
    '--theme-gradient-diag': `linear-gradient(135deg, ${stops})`,
    '--theme-gradient-vertical': `linear-gradient(180deg, ${stops})`,
    '--bg-intensity': theme.backgroundIntensity.toFixed(3),
    '--glow-strength': theme.glowStrength.toFixed(3)
  }
}

let applied: ThemeCssVars | null = null

/** Write the theme variables to the root element (only the ones that changed). */
export function applyThemeCssVars(
  colors: ColorSettings,
  artworkPalette: readonly string[] | null = null,
  root: HTMLElement = document.documentElement
): void {
  const vars = themeCssVars(colors, artworkPalette)
  for (const key of Object.keys(vars) as (keyof ThemeCssVars)[]) {
    if (!applied || applied[key] !== vars[key]) root.style.setProperty(key, vars[key])
  }
  applied = vars
}

/** Gradient CSS for an arbitrary list of hex stops (used by palette swatches). */
export function gradientCss(stops: readonly string[], angle = 90): string {
  if (stops.length === 0) return 'transparent'
  if (stops.length === 1) return stops[0]
  return `linear-gradient(${angle}deg, ${stops.join(', ')})`
}
