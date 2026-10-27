/**
 * Small album-art palette extractor. The image is sampled on a 64 px canvas and
 * quantised into colour buckets, which keeps the work bounded and avoids adding a
 * runtime dependency for a task the browser canvas can handle directly.
 */
import type { ArtworkPalette } from './types'
import { isNeutralColor, rgbToHex, type Rgb } from './theme'

const SAMPLE_SIZE = 64
const MAX_COLORS = 5
const MIN_COLOR_DISTANCE = 40

interface Bucket extends Rgb {
  count: number
  saturation: number
  lightness: number
}

function colorMetrics(r: number, g: number, b: number): { saturation: number; lightness: number } {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  const lightness = (max + min) * 0.5
  const delta = max - min
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))
  return { saturation, lightness }
}

function distance(a: Rgb, b: Rgb): number {
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  return Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11)
}

function collectBuckets(data: Uint8ClampedArray, minSaturation: number, minLightness: number, maxLightness = 0.92): Bucket[] {
  const buckets = new Map<number, Bucket>()
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 160) continue
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const { saturation, lightness } = colorMetrics(r, g, b)
    if (lightness < minLightness || lightness > maxLightness || saturation < minSaturation) continue

    // Five bits per channel preserves useful variation while merging compression noise.
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.r += r
      bucket.g += g
      bucket.b += b
      bucket.saturation += saturation
      bucket.lightness += lightness
      bucket.count++
    } else {
      buckets.set(key, { r, g, b, saturation, lightness, count: 1 })
    }
  }
  return [...buckets.values()].map((bucket) => ({
    r: bucket.r / bucket.count,
    g: bucket.g / bucket.count,
    b: bucket.b / bucket.count,
    saturation: bucket.saturation / bucket.count,
    lightness: bucket.lightness / bucket.count,
    count: bucket.count
  }))
}

/** Merge textured shades by hue so a broad colour region can beat a flat grey bucket. */
function mergeSimilarShades(buckets: Bucket[]): Bucket[] {
  const groups = new Map<string, { r: number; g: number; b: number; weight: number; count: number }>()
  for (const bucket of buckets) {
    const max = Math.max(bucket.r, bucket.g, bucket.b)
    const min = Math.min(bucket.r, bucket.g, bucket.b)
    const delta = max - min
    let hue = 0
    if (delta > 0) {
      hue = max === bucket.r ? (bucket.g - bucket.b) / delta
        : max === bucket.g ? (bucket.b - bucket.r) / delta + 2
        : (bucket.r - bucket.g) / delta + 4
      hue = (hue * 60 + 360) % 360
    }
    const neutral = isNeutralColor(bucket)
    const key = neutral ? `grey:${Math.floor(bucket.lightness * 4)}` : `hue:${Math.round(hue / 15) % 24}`
    const weight = bucket.count * (neutral ? 1 : (0.1 + bucket.saturation ** 2) * (0.2 + bucket.lightness))
    const group = groups.get(key) ?? { r: 0, g: 0, b: 0, weight: 0, count: 0 }
    group.r += bucket.r * weight
    group.g += bucket.g * weight
    group.b += bucket.b * weight
    group.weight += weight
    group.count += bucket.count
    groups.set(key, group)
  }
  return [...groups.values()].map(group => {
    const r = group.r / group.weight
    const g = group.g / group.weight
    const b = group.b / group.weight
    return { r, g, b, count: group.count, ...colorMetrics(r, g, b) }
  })
}

/** Pure pixel-data entry point, exported for unit tests. */
export function extractPaletteFromPixels(data: Uint8ClampedArray): ArtworkPalette {
  if (data.length < 4) return []

  // Dark pixels are real cover area, not missing data. Dropping them makes small
  // bright details look dominant. Visibility is handled separately by the theme.
  let buckets = mergeSimilarShades(collectBuckets(data, 0, 0, 1))
  const pixelCount = buckets.reduce((sum, bucket) => sum + bucket.count, 0)
  if (buckets.some(bucket => !isNeutralColor(bucket) && bucket.count >= pixelCount * 0.01)) {
    // One neutral slot on mixed artwork represents all neutral pixels by area.
    // Choosing the brightest bucket turned black backgrounds into light grey.
    const neutral = buckets.filter(isNeutralColor)
    const count = neutral.reduce((sum, bucket) => sum + bucket.count, 0)
    if (count) {
      const mean = (channel: 'r' | 'g' | 'b'): number => neutral.reduce((sum,bucket)=>sum+bucket[channel]*bucket.count,0)/count
      const r=mean('r'),g=mean('g'),b=mean('b')
      buckets = [...buckets.filter(bucket=>!isNeutralColor(bucket)), {r,g,b,count,...colorMetrics(r,g,b)}]
    }
  }

  buckets.sort((a, b) => {
    const score = (v: Bucket): number => {
      const midtone = 1 - Math.min(1, Math.abs(v.lightness - 0.52) * 1.5)
      return v.count * (0.7 + v.saturation * 1.5) * (0.75 + midtone * 0.5)
    }
    return score(b) - score(a)
  })

  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0)
  const hue = (color: Rgb): number => {
    const max = Math.max(color.r, color.g, color.b)
    const min = Math.min(color.r, color.g, color.b)
    const delta = max - min
    if (!delta) return 0
    const h = max === color.r ? (color.g - color.b) / delta
      : max === color.g ? (color.b - color.r) / delta + 2 : (color.r - color.g) / delta + 4
    return (h * 60 + 360) % 360
  }
  // Several small neighbouring shades can form one real accent. Assess their
  // combined area before discarding them; retain a per-shade noise floor.
  const chromatic=buckets.filter(bucket=>!isNeutralColor(bucket))
  const coloured=chromatic.filter(bucket=>bucket.count>=total*0.003 &&
    chromatic.reduce((sum,other)=>{
      const angle=Math.abs(hue(bucket)-hue(other))
      return sum+(Math.min(angle,360-angle)<=30 ? other.count : 0)
    },0)>=total*0.01)

  const neutrals = buckets.filter(bucket => isNeutralColor(bucket) && bucket.count >= total * 0.02)
  // Mixed artwork has one area-weighted neutral representative.
  const grey = neutrals.reduce<Bucket | undefined>((best, bucket) =>
    !best || bucket.lightness > best.lightness ? bucket : best, undefined)
  const selected: Bucket[] = []
  if (coloured.length) {
    for (const bucket of coloured) {
      if (selected.every(color => {
        const angle = Math.abs(hue(color) - hue(bucket))
        // Different dark hues must not disappear merely because their RGB distance is small.
        return Math.min(angle, 360 - angle) >= 45
      })) {
        selected.push(bucket)
        if (selected.length === MAX_COLORS - (grey ? 1 : 0)) break
      }
    }
    // Reserve slots for broad hue families first, then recover adjacent colours such
    // as blue/cyan/green. They must not collapse into a single average on cool covers.
    for (const bucket of coloured) {
      if (selected.length >= MAX_COLORS - (grey ? 1 : 0)) break
      if (selected.every(color => {
        const angle = Math.abs(hue(color) - hue(bucket))
        return Math.min(angle, 360 - angle) >= 25
      })) selected.push(bucket)
    }
    // Only use additional shades after the distinct hue families have had a chance.
    for (const bucket of coloured) {
      if (selected.length >= MAX_COLORS - (grey ? 1 : 0)) break
      if (selected.every(color => distance(color, bucket) >= MIN_COLOR_DISTANCE)) selected.push(bucket)
    }
    // Its position follows the same coverage ranking as the colours, not a fixed band.
    if (grey) selected.push(grey)
    selected.sort((a, b) => buckets.indexOf(a) - buckets.indexOf(b))
    // Keep the strongest colour as the menu accent even on a grey-dominated cover.
    const main = selected.findIndex(bucket => !isNeutralColor(bucket))
    if (main > 0) selected.unshift(selected.splice(main, 1)[0])
  } else {
    for (const bucket of buckets) {
      if (selected.every(color => distance(color, bucket) >= MIN_COLOR_DISTANCE)) selected.push(bucket)
      if (selected.length === MAX_COLORS) break
    }
  }
  const coverage = selected.map(() => 0)
  for (const bucket of buckets) {
    const matching = selected.map((color, i) => ({ color, i })).filter(({color}) => isNeutralColor(color) === isNeutralColor(bucket))
    if (!matching.length) continue
    const nearest = matching.reduce((best, candidate) => {
      const difference = (color: Bucket): number => {
        if (isNeutralColor(bucket)) return distance(color, bucket)
        const angle = Math.abs(hue(color) - hue(bucket))
        return Math.min(angle, 360 - angle) * 2 + distance(color, bucket)
      }
      return difference(candidate.color) < difference(best.color) ? candidate : best
    })
    coverage[nearest.i] += bucket.count
  }
  const sum = coverage.reduce((a,b)=>a+b,0)
  const palette: ArtworkPalette = selected.map(rgbToHex)
  // Area metadata stays attached to the runtime palette, never to a serialized settings array.
  Object.defineProperty(palette, 'weights', { value: coverage.map(count => count / sum) })
  return palette
}

/** Extract one to five dominant, usable colours from a decoded artwork image. */
export function extractArtworkPalette(image: HTMLImageElement): ArtworkPalette {
  const width = image.naturalWidth || image.width
  const height = image.naturalHeight || image.height
  if (width <= 0 || height <= 0) return []

  const scale = Math.min(1, SAMPLE_SIZE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return []

  try {
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    return extractPaletteFromPixels(ctx.getImageData(0, 0, canvas.width, canvas.height).data)
  } catch {
    // A malformed or unexpectedly restricted image must never break rendering.
    return []
  }
}
