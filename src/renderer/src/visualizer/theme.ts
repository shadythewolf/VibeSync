/**
 * Colour theme resolution. `resolveTheme()` turns ColorSettings into a ResolvedTheme
 * with pre-computed 256-entry colour lookup tables so renderers never build colour
 * strings per bar per frame.
 */
import type { ColorMode, ColorSettings } from '@shared/settings'
import type { ArtworkPalette, ResolvedTheme } from './types'

export const PALETTES: Record<Exclude<ColorMode, 'custom' | 'albumArt'>, string[]> = {
  rainbow: ['#FF3B3B', '#FF9F1C', '#FFE600', '#2BFF88', '#00E5FF', '#3B6BFF', '#B44CFF', '#FF3BD4'],
  neon: ['#00F0FF', '#4C7DFF', '#B44CFF', '#FF3BD4', '#FF7A00', '#39FF14'],
  cyanPurple: ['#00F0FF', '#4C8DFF', '#8A5CFF', '#B44CFF'],
  pinkBlue: ['#FF3BD4', '#C84CFF', '#7A5CFF', '#3B8BFF'],
  fire: ['#FF2A00', '#FF6A00', '#FFB300', '#FFE97A'],
  ocean: ['#003C8F', '#0077FF', '#00C2FF', '#7AF5FF']
}

const LUT_SIZE = 256
const ALBUM_ART_TRANSITION_MS = 900
const ALBUM_ART_TRANSITION_STEPS = 18
// Brightness floors (Rec. 709 luminance, 0..255) for album-art colours on the near-black background.
const ARTWORK_MINIMUM = 112
const ARTWORK_NEUTRAL_MINIMUM = 30
// Strongest-channel floor for dark tinted colours (a black background with a slight teal or navy
// cast) when the cover also has a bright colour: lifted just enough to be visible, never further.
// Lifting them towards ARTWORK_MINIMUM turned such backgrounds into clearly coloured bars. An
// all-dark cover keeps the full lift, or the visualizer would barely show.
const ARTWORK_DARK_MINIMUM = 30
// A colour this strong in one channel counts as bright even below ARTWORK_MINIMUM luminance:
// luminance rates a vivid red such as #B65354 at only 104.
const ARTWORK_BRIGHT_CHANNEL = 128
export const ALBUM_ART_FALLBACK = ['#9CA3AF', '#D1D5DB']

export interface Rgb {
  r: number
  g: number
  b: number
}

export function hexToRgb(hex: string): Rgb {
  let h = hex.trim().replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  if (!Number.isFinite(n)) return { r: 255, g: 255, b: 255 }
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return ('#' + c(r) + c(g) + c(b)).toUpperCase()
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t }
}

/** Ignore channel noise as well as slight tint, while preserving coloured shadows. */
export function isNeutralColor({ r, g, b }: Rgb): boolean {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  // Relative saturation is unstable at the RGB black floor (for example 2,0,3).
  // Preserve near-black coverage as neutral rather than amplifying channel noise.
  return max * 255 <= 4 || Math.max(r, g, b) - Math.min(r, g, b) <= 2 || (max - min) / (1 - Math.abs(max + min - 1)) < 0.15
}

export function rgbaString(c: Rgb, alpha: number): string {
  return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${alpha.toFixed(3)})`
}

/** Interpolate along gradient stops; t in 0..1. */
export function sampleStops(stops: Rgb[], t: number): Rgb {
  if (stops.length === 1) return stops[0]
  const x = Math.max(0, Math.min(0.999999, t)) * (stops.length - 1)
  const i = Math.floor(x)
  return mixRgb(stops[i], stops[Math.min(stops.length - 1, i + 1)], x - i)
}

export function withAlpha(hex: string, alpha: number): string {
  return rgbaString(hexToRgb(hex), alpha)
}

/** Relative luminance helper used for readable text on coloured chips. */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

const cache = new WeakMap<ColorSettings, ResolvedTheme>()
let lastKey = ''
let lastTheme: ResolvedTheme | null = null

export function paletteFor(colors: ColorSettings, artworkPalette: readonly string[] | null = null): ArtworkPalette {
  if (colors.mode === 'custom') return [colors.primary, colors.secondary]
  if (colors.mode === 'albumArt') {
    if (!artworkPalette?.length) return ALBUM_ART_FALLBACK
    // Preserve the cover's extracted order; neutral colours get no reserved position.
    const palette: ArtworkPalette = [...artworkPalette]
    const weights = (artworkPalette as ArtworkPalette).weights
    if (weights) Object.defineProperty(palette, 'weights', { value: [...weights] })
    return palette
  }
  return PALETTES[colors.mode]
}

function smoothArtworkAnchors(anchors: { color: string; position: number }[]): { color: string; position: number }[] {
  // Sample the eased direct RGB blend once per theme; canvas, CSS and the bar LUT share it.
  const smooth: { color: string; position: number }[] = [anchors[0]]
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i]
    if (a.color !== b.color && b.position > a.position) {
      const from = hexToRgb(a.color), to = hexToRgb(b.color)
      for (let step = 1; step < 16; step++) {
        const x = step / 16
        const eased = x * x * (3 - 2 * x)
        smooth.push({ color: rgbToHex(mixRgb(from, to, eased)), position: a.position + (b.position - a.position) * x })
      }
    }
    smooth.push(b)
  }
  return smooth
}
/** Limit neutral accents on colourful covers while preserving predominantly neutral artwork. */
function artworkGradientStops(stops: string[], mixed: boolean, weights?: number[]): { color: string; position: number }[] {
  if(mixed) {
    // Sort the one source gradient, keeping measured areas attached. The renderer's
    // existing mirror naturally places its bright start at the centre on both sides.
    const order=stops.map((_,i)=>i).sort((a,b)=>luminance(stops[b])-luminance(stops[a]))
    const sourceWeights=weights
    stops=order.map(i=>stops[i])
    weights=sourceWeights?.length===order.length ? order.map(i=>sourceWeights[i]) : sourceWeights
  }
  const neutral = stops.map(hex => isNeutralColor(hexToRgb(hex)))
  const greyCount = neutral.filter(Boolean).length
  const measured = weights?.length === stops.length && weights.every(w => Number.isFinite(w) && w > 0) ? weights : undefined
  if (!mixed || (greyCount === stops.length && !measured)) {
    return stops.map((color, i) => ({ color, position: stops.length === 1 ? 0 : i / (stops.length - 1) }))
  }
  if (!greyCount && !measured) {
    return smoothArtworkAnchors(stops.map((color, i) => ({ color, position: stops.length === 1 ? 0 : i / (stops.length - 1) })))
  }
  const coverage = measured ?? stops.map(() => 1 / stops.length)
  const total = coverage.reduce((a,b)=>a+b,0)
  const greyCoverage = coverage.reduce((sum,weight,i)=>sum+(neutral[i]?weight:0),0)
  const rawGreyShare = greyCoverage / total
  // Reduce neutral accents only when colour dominates. A grayscale cover with a small
  // coloured detail must retain its measured neutral majority. Ease the policy between
  // 25% and 50% neutral coverage, rather than flipping at a single threshold.
  const dominance = measured ? Math.max(0,Math.min(1,(rawGreyShare-0.25)/0.25)) : 0
  const easedDominance = dominance * dominance * (3 - 2 * dominance)
  const cappedShare = Math.min(0.08,rawGreyShare)
  const greyShare = cappedShare + (rawGreyShare-cappedShare)*easedDominance
  const colourCoverage = total - greyCoverage
  const widths = coverage.map((weight,i) => greyCount === stops.length ? weight / total : neutral[i] ? greyShare * weight / greyCoverage : (1-greyShare) * weight / colourCoverage)
  const anchors: { color: string; position: number }[] = []
  let start = 0
  for (let i = 0; i < stops.length; i++) {
    const end = start + widths[i]
    const leftBlend = i === 0 ? 0 : Math.min(neutral[i] || neutral[i - 1] ? 0.04 : 0.10, widths[i] / 2, widths[i - 1] / 2)
    const rightBlend = i === stops.length - 1 ? 0 : Math.min(neutral[i] || neutral[i + 1] ? 0.04 : 0.10, widths[i] / 2, widths[i + 1] / 2)
    anchors.push({ color: stops[i], position: start + leftBlend }, { color: stops[i], position: Math.min(1, end - rightBlend) })
    start = end
  }
  anchors[anchors.length - 1].position = 1
  return smoothArtworkAnchors(anchors)
}

function sampleGradient(anchors: { color: string; position: number }[], t: number): Rgb {
  if (t <= anchors[0].position) return hexToRgb(anchors[0].color)
  for (let i = 1; i < anchors.length; i++) {
    if (t <= anchors[i].position) {
      const a = anchors[i - 1], b = anchors[i]
      return mixRgb(hexToRgb(a.color), hexToRgb(b.color), (t - a.position) / (b.position - a.position))
    }
  }
  return hexToRgb(anchors[anchors.length - 1].color)
}

function artworkBrightness({ r, g, b }: Rgb): number {
  return r*0.2126+g*0.7152+b*0.0722
}

/**
 * Keep dark cover tones visible without replacing them with pale grey or new hues.
 * `keepDark`: the cover has a colour bright enough on its own, so near-black tones stay dark.
 */
function visibleArtworkColor(hex: string, keepDark: boolean): string {
  const rgb=hexToRgb(hex)
  const brightness=artworkBrightness(rgb)
  const minimum=ARTWORK_MINIMUM
  const neutralMinimum=ARTWORK_NEUTRAL_MINIMUM
  if (brightness >= minimum) return hex
  if (isNeutralColor(rgb)) {
    const lift=Math.max(0,neutralMinimum-brightness)
    return rgbToHex({r:rgb.r+lift,g:rgb.g+lift,b:rgb.b+lift})
  }
  // Luminance is relatively insensitive to blue. Raising every hue to the same
  // luminance made navy much brighter than red/green. Bound the strongest channel
  // instead, preserving already visible colours and dark chromatic shadows.
  const strongest=Math.max(rgb.r,rgb.g,rgb.b)
  const target=keepDark ? ARTWORK_DARK_MINIMUM : minimum
  const scale=Math.max(1,target/strongest)
  // Fade in ratio-preserving amplification only as the source leaves the black
  // floor. Tiny absolute differences must not become vivid through a large gain.
  const confidence=Math.max(0,Math.min(1,(strongest-4)/24))
  const chromaWeight=confidence*confidence*(3-2*confidence)
  // Next to a bright colour the grey fallback must not outshine the dark floor either.
  const lift=keepDark ? Math.max(0,target-strongest) : Math.max(0,neutralMinimum-brightness)
  return rgbToHex(mixRgb(
    {r:rgb.r+lift,g:rgb.g+lift,b:rgb.b+lift},
    {r:rgb.r*scale,g:rgb.g*scale,b:rgb.b*scale},chromaWeight))
}

function buildTheme(colors: ColorSettings, stopsHex: ArtworkPalette, applyCoverage = true): ResolvedTheme {
  // Lift only the source anchors; keep the same direct RGB interpolation afterwards.
  const keepDark = stopsHex.some(hex => {
    const rgb = hexToRgb(hex)
    return artworkBrightness(rgb) >= ARTWORK_MINIMUM || Math.max(rgb.r, rgb.g, rgb.b) >= ARTWORK_BRIGHT_CHANNEL
  })
  const visibleStops = colors.mode === 'albumArt' ? stopsHex.map(hex => visibleArtworkColor(hex, keepDark)) : stopsHex
  const gradientStops = artworkGradientStops(visibleStops, colors.mode === 'albumArt' && applyCoverage, stopsHex.weights)
  const lutRgb: Rgb[] = new Array(LUT_SIZE)
  const lutHex: string[] = new Array(LUT_SIZE)
  for (let i = 0; i < LUT_SIZE; i++) {
    const c = sampleGradient(gradientStops, i / (LUT_SIZE - 1))
    lutRgb[i] = c
    lutHex[i] = rgbToHex(c)
  }
  const brightLut: string[] = new Array(LUT_SIZE)
  const sheenLut=new Float32Array(LUT_SIZE)
  for (let i = 0; i < LUT_SIZE; i++) {
    const c = lutRgb[i]
    // A fixed white overlay turns near-black cover regions into light grey.
    // Keep their local peak response subtle, fading to the normal highlight for
    // brighter neutrals. Coloured bar highlights keep their existing response.
    const brightness=c.r*0.2126+c.g*0.7152+c.b*0.0722
    const amount=Math.max(0,Math.min(1,(brightness-(ARTWORK_NEUTRAL_MINIMUM-8))/40))
    sheenLut[i]=colors.mode==='albumArt' && isNeutralColor(c) ? amount*amount*(3-2*amount) : 1
    const strength=0.35*sheenLut[i]
    brightLut[i] = rgbToHex({ r: c.r + (255 - c.r) * strength, g: c.g + (255 - c.g) * strength, b: c.b + (255 - c.b) * strength })
  }

  const primary = colors.mode === 'custom' ? colors.primary : stopsHex[0]
  const secondary = colors.mode === 'custom' ? colors.secondary : stopsHex[stopsHex.length - 1]
  const accent = stopsHex[Math.floor(stopsHex.length / 2)]
  const idx = (t: number): number => {
    const i = Math.round((t <= 0 ? 0 : t >= 1 ? 1 : t) * (LUT_SIZE - 1))
    return i !== i ? 0 : i
  }

  return {
    stops: stopsHex,
    gradientStops,
    primary,
    secondary,
    accent,
    text: '#F4F6FF',
    textDim: 'rgba(244,246,255,0.55)',
    panel: 'rgba(16,18,28,0.72)',
    border: 'rgba(255,255,255,0.08)',
    background: '#020203',
    backgroundIntensity: colors.backgroundIntensity,
    glowStrength: colors.glowStrength,
    colorAt: (t) => lutHex[idx(t)],
    colorAtAlpha: (t, alpha) => rgbaString(lutRgb[idx(t)], alpha),
    barColor: (index, count, level) => {
      const t = count <= 1 ? 0 : index / (count - 1)
      return level > 0.85 ? brightLut[idx(t)] : lutHex[idx(t)]
    },
    barSheenOpacity: colors.mode==='albumArt' ? (index,count)=>sheenLut[idx(count<=1 ? 0 : index/(count-1))] : undefined,
    gradient: (ctx, x0, y0, x1, y1, alpha = 1) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1)
      for (const stop of gradientStops) {
        g.addColorStop(stop.position, alpha >= 1 ? stop.color : rgbaString(hexToRgb(stop.color), alpha))
      }
      return g
    }
  }
}

/** Resolve the target palette without animation, for React/CSS surfaces that do not draw every frame. */
export function resolveThemeImmediate(colors: ColorSettings, artworkPalette: readonly string[] | null = null): ResolvedTheme {
  return buildTheme(colors, paletteFor(colors, artworkPalette))
}

interface AlbumTransition {
  targetKey: string
  startedAt: number
  themes: ResolvedTheme[]
}

let albumTransition: AlbumTransition | null = null

function transitionIndex(transition: AlbumTransition, now: number): number {
  const elapsed = Math.max(0, now - transition.startedAt)
  return Math.min(ALBUM_ART_TRANSITION_STEPS, Math.floor((elapsed / ALBUM_ART_TRANSITION_MS) * ALBUM_ART_TRANSITION_STEPS))
}

function resolveAlbumArtTheme(colors: ColorSettings, artworkPalette: readonly string[] | null, now: number): ResolvedTheme {
  const targetHex = paletteFor(colors, artworkPalette)
  const targetKey = `${targetHex.join(',')}|${targetHex.weights?.join(',') ?? ''}|${colors.backgroundIntensity}|${colors.glowStrength}`
  if (!albumTransition) {
    const theme = buildTheme(colors, targetHex)
    albumTransition = { targetKey, startedAt: now - ALBUM_ART_TRANSITION_MS, themes: [theme] }
    return theme
  }

  if (albumTransition.targetKey !== targetKey) {
    const current = albumTransition.themes[transitionIndex(albumTransition, now)] ?? albumTransition.themes.at(-1)!
    const target = buildTheme(colors, targetHex)
    const count = 64
    // Fade the actual area-weighted gradients, rather than redistributing their raw stops.
    const from = Array.from({length:count},(_,i)=>hexToRgb(current.colorAt(i/(count-1))))
    const to = Array.from({length:count},(_,i)=>hexToRgb(target.colorAt(i/(count-1))))
    const themes: ResolvedTheme[] = []
    for (let step = 0; step <= ALBUM_ART_TRANSITION_STEPS; step++) {
      const x = step / ALBUM_ART_TRANSITION_STEPS
      const eased = x * x * (3 - 2 * x)
      const stops = from.map((color, i) => rgbToHex(mixRgb(color, to[i], eased)))
      themes.push(step === ALBUM_ART_TRANSITION_STEPS ? target : buildTheme(colors, stops, false))
    }
    albumTransition = { targetKey, startedAt: now, themes }
  }

  return albumTransition.themes[transitionIndex(albumTransition, now)] ?? albumTransition.themes.at(-1)!
}

export function resolveTheme(
  colors: ColorSettings,
  artworkPalette: readonly string[] | null = null,
  now: number = typeof performance === 'undefined' ? Date.now() : performance.now()
): ResolvedTheme {
  if (colors.mode === 'albumArt') return resolveAlbumArtTheme(colors, artworkPalette, now)
  const cached = cache.get(colors)
  if (cached) return cached
  const key = `${colors.mode}|${colors.primary}|${colors.secondary}|${colors.backgroundIntensity}|${colors.glowStrength}`
  if (lastTheme && key === lastKey) {
    cache.set(colors, lastTheme)
    return lastTheme
  }

  const theme = buildTheme(colors, paletteFor(colors))
  cache.set(colors, theme)
  lastKey = key
  lastTheme = theme
  return theme
}
