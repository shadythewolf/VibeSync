#!/usr/bin/env node
/**
 * VibeSync icon generator.
 *
 * Authors the app mark as SVG, rasterises it with sharp (librsvg) and writes:
 *
 *   build/icon.ico                 multi-size Windows icon (PNG-compressed entries, incl. 256x256)
 *   build/icon.png                 512x512  (electron-builder fallback / Linux-style icon)
 *   build/icon-256.png             256x256
 *   build/icon-1024.png            1024x1024 master render
 *   build/icons/icon-<size>.png    every individual size that went into the .ico
 *   build/tray.png                 32x32 simplified mark on a transparent background
 *   build/tray@2x.png              64x64 simplified mark on a transparent background
 *   src/renderer/src/assets/logo.svg   the same mark, 64x64 viewBox, no filters (for the UI)
 *
 * No dependencies besides `sharp` (already a devDependency). Run with `npm run icons`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(scriptDir, '..')
const BUILD_DIR = path.join(ROOT, 'build')
const ICONS_DIR = path.join(BUILD_DIR, 'icons')
const LOGO_PATH = path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'logo.svg')

/** Sizes packed into build/icon.ico (Windows shell + electron-builder requirement: 256). */
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
/** Additional stand-alone renders. */
const EXTRA_SIZES = [512, 1024]
/** Sizes at or below this use the simplified mark (ring + 3 bars). */
const SIMPLE_MAX_SIZE = 32

const COLORS = {
  bg: '#0B0C14',
  cyan: '#00F0FF',
  purple: '#B44CFF',
  pink: '#FF3BD4',
  text: '#F4F6FF'
}

// ---------------------------------------------------------------------------
// SVG authoring (all geometry in a 1024 x 1024 user space)
// ---------------------------------------------------------------------------

/**
 * Seven equaliser bars whose top and bottom edges both follow a "V" - the bar towards the
 * centre is the longest and sits lowest. Pitch 84 px, bar width 50 px, rounded caps.
 */
const FULL_BARS = [
  { x: 260, top: 470, bottom: 650 },
  { x: 344, top: 420, bottom: 670 },
  { x: 428, top: 350, bottom: 690 },
  { x: 512, top: 290, bottom: 710 },
  { x: 596, top: 350, bottom: 690 },
  { x: 680, top: 420, bottom: 670 },
  { x: 764, top: 470, bottom: 650 }
]
const FULL_BAR_WIDTH = 50

/** Simplified mark for 16-32 px: a thicker ring and three bold bars. */
const SIMPLE_BARS = [
  { x: 296, top: 450, bottom: 680 },
  { x: 512, top: 290, bottom: 710 },
  { x: 728, top: 450, bottom: 680 }
]
const SIMPLE_BAR_WIDTH = 128

function barRects(bars, width, extraAttrs = '') {
  const half = width / 2
  return bars
    .map(
      (b) =>
        `<rect x="${b.x - half}" y="${b.top}" width="${width}" height="${b.bottom - b.top}" rx="${half}" ry="${half}"${extraAttrs}/>`
    )
    .join('\n      ')
}

/**
 * Build the icon SVG.
 * @param {object} opts
 * @param {'full'|'simple'} [opts.variant]   detail level
 * @param {boolean} [opts.background]        draw the dark rounded square
 * @param {boolean} [opts.filters]           use feGaussianBlur glow (off for the UI logo)
 * @param {number}  [opts.viewBox]           viewBox edge length (1024 or 64); geometry is scaled
 * @param {string}  [opts.idPrefix]          prefix for gradient/filter ids (avoid clashes when inlined)
 */
export function buildIconSvg(opts = {}) {
  const { variant = 'full', background = true, filters = true, viewBox = 1024, idPrefix = 'vd' } = opts
  const id = (name) => `${idPrefix}-${name}`
  const simple = variant === 'simple'
  const { bg, cyan, purple, pink, text } = COLORS

  const ringRadius = simple ? 384 : 392
  const ringWidth = simple ? 96 : 52
  const innerRadius = ringRadius - ringWidth / 2

  const defs = []
  defs.push(`<radialGradient id="${id('bgHi')}" cx="0.30" cy="0.22" r="0.80">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.11"/>
      <stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0.025"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>`)
  defs.push(`<radialGradient id="${id('disc')}" cx="0.5" cy="0.44" r="0.56">
      <stop offset="0" stop-color="#1B1E30"/>
      <stop offset="0.65" stop-color="#11131F"/>
      <stop offset="1" stop-color="#0C0E17"/>
    </radialGradient>`)
  defs.push(`<linearGradient id="${id('ring')}" gradientUnits="userSpaceOnUse" x1="170" y1="170" x2="854" y2="854">
      <stop offset="0" stop-color="${cyan}"/>
      <stop offset="0.5" stop-color="${purple}"/>
      <stop offset="1" stop-color="${pink}"/>
    </linearGradient>`)
  defs.push(`<linearGradient id="${id('bars')}" gradientUnits="userSpaceOnUse" x1="235" y1="0" x2="789" y2="0">
      <stop offset="0" stop-color="${cyan}"/>
      <stop offset="0.5" stop-color="${purple}"/>
      <stop offset="1" stop-color="${pink}"/>
    </linearGradient>`)
  defs.push(`<linearGradient id="${id('ringHi')}" gradientUnits="userSpaceOnUse" x1="512" y1="120" x2="512" y2="904">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.35"/>
      <stop offset="0.35" stop-color="#FFFFFF" stop-opacity="0"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>`)
  if (filters) {
    defs.push(`<filter id="${id('glowRing')}" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">
      <feGaussianBlur stdDeviation="${simple ? 30 : 24}"/>
    </filter>`)
    defs.push(`<filter id="${id('glowBars')}" x="-40%" y="-30%" width="180%" height="160%" color-interpolation-filters="sRGB">
      <feGaussianBlur stdDeviation="${simple ? 22 : 15}"/>
    </filter>`)
  }

  const layers = []

  if (background) {
    layers.push(`<rect x="0" y="0" width="1024" height="1024" rx="220" ry="220" fill="${bg}"/>`)
    layers.push(`<rect x="0" y="0" width="1024" height="1024" rx="220" ry="220" fill="url(#${id('bgHi')})"/>`)
    if (!simple) {
      layers.push(
        `<rect x="7" y="7" width="1010" height="1010" rx="213" ry="213" fill="none" stroke="#FFFFFF" stroke-opacity="0.06" stroke-width="6"/>`
      )
    }
  }

  // Vinyl disc under the ring (full variant only - too fine for 16 px).
  if (!simple) {
    layers.push(`<circle cx="512" cy="512" r="${innerRadius}" fill="url(#${id('disc')})"/>`)
    layers.push(`<circle cx="512" cy="512" r="332" fill="none" stroke="#FFFFFF" stroke-opacity="0.05" stroke-width="3"/>`)
    layers.push(`<circle cx="512" cy="512" r="298" fill="none" stroke="#FFFFFF" stroke-opacity="0.04" stroke-width="3"/>`)
  }

  // Ring glow + ring.
  if (filters) {
    layers.push(
      `<circle cx="512" cy="512" r="${ringRadius}" fill="none" stroke="url(#${id('ring')})" stroke-width="${ringWidth + 26}" opacity="0.55" filter="url(#${id('glowRing')})"/>`
    )
  }
  layers.push(`<circle cx="512" cy="512" r="${ringRadius}" fill="none" stroke="url(#${id('ring')})" stroke-width="${ringWidth}" stroke-dasharray="${2 * Math.PI * ringRadius * 0.43} ${2 * Math.PI * ringRadius * 0.07}" transform="rotate(-78 512 512)"/>`)
  if (!simple) {
    // Thin specular highlight on the top of the ring gives it a glossy turntable-platter feel.
    layers.push(
      `<circle cx="512" cy="512" r="${ringRadius + ringWidth / 2 - 6}" fill="none" stroke="url(#${id('ringHi')})" stroke-width="5"/>`
    )
  }

  // Equaliser "V".
  const bars = simple ? SIMPLE_BARS : FULL_BARS
  const barWidth = simple ? SIMPLE_BAR_WIDTH : FULL_BAR_WIDTH
  if (filters) {
    layers.push(`<g fill="url(#${id('bars')})" opacity="0.8" filter="url(#${id('glowBars')})">
      ${barRects(bars, barWidth)}
    </g>`)
  }
  layers.push(`<g fill="url(#${id('bars')})">
      ${barRects(bars, barWidth)}
    </g>`)
  if (!simple) {
    // Soft highlight strip on each bar for a tubular neon look.
    layers.push(`<g fill="#FFFFFF" opacity="0.22">
      ${barRects(
        bars.map((b) => ({ x: b.x - 9, top: b.top + 14, bottom: b.bottom - 14 })),
        12
      )}
    </g>`)

  }

  const scale = viewBox / 1024
  const body = scale === 1 ? layers.join('\n    ') : `<g transform="scale(${scale})">\n    ${layers.join('\n    ')}\n    </g>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${viewBox}" height="${viewBox}" viewBox="0 0 ${viewBox} ${viewBox}" role="img" aria-label="VibeSync">
  <defs>
    ${defs.join('\n    ')}
  </defs>
    ${body}
</svg>
`
}

// ---------------------------------------------------------------------------
// Rasterisation
// ---------------------------------------------------------------------------

/**
 * Render an SVG string to an RGBA PNG buffer of `size` x `size`.
 * Small sizes are rasterised at 4x and downsampled with Lanczos for crisp edges.
 */
async function renderPng(svg, size) {
  const superSample = size < 256 ? 4 : 1
  const rasterSize = size * superSample
  const density = (72 * rasterSize) / 1024
  const image = sharp(Buffer.from(svg), { density })
  const buf = await image
    .resize(size, size, { fit: 'contain', kernel: 'lanczos3', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toBuffer()
  const meta = await sharp(buf).metadata()
  if (meta.width !== size || meta.height !== size || meta.channels !== 4) {
    throw new Error(`render of ${size}px produced ${meta.width}x${meta.height} with ${meta.channels} channels`)
  }
  return buf
}

// ---------------------------------------------------------------------------
// ICO packing (ICONDIR + ICONDIRENTRY[] + PNG blobs)
// ---------------------------------------------------------------------------

const ICONDIR_SIZE = 6
const ICONDIRENTRY_SIZE = 16
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * @param {{ size: number, png: Buffer }[]} entries  sorted ascending by size
 */
export function packIco(entries) {
  if (entries.length === 0 || entries.length > 255) throw new Error('ICO needs 1..255 images')
  const headerSize = ICONDIR_SIZE + ICONDIRENTRY_SIZE * entries.length
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = icon
  header.writeUInt16LE(entries.length, 4)
  let offset = headerSize
  entries.forEach((e, i) => {
    if (e.size < 1 || e.size > 256) throw new Error(`ICO entry size out of range: ${e.size}`)
    const o = ICONDIR_SIZE + i * ICONDIRENTRY_SIZE
    const dim = e.size === 256 ? 0 : e.size // 256 is encoded as 0
    header.writeUInt8(dim, o)
    header.writeUInt8(dim, o + 1)
    header.writeUInt8(0, o + 2) // colour count (0 = no palette)
    header.writeUInt8(0, o + 3) // reserved
    header.writeUInt16LE(1, o + 4) // colour planes
    header.writeUInt16LE(32, o + 6) // bits per pixel
    header.writeUInt32LE(e.png.length, o + 8) // bytes in resource
    header.writeUInt32LE(offset, o + 12) // offset from start of file
    offset += e.png.length
  })
  return Buffer.concat([header, ...entries.map((e) => e.png)])
}

/**
 * Parse an ICO buffer and verify every entry is a PNG whose IHDR matches the directory entry.
 * @returns {{ size: number, bytes: number, offset: number, kind: string }[]}
 */
export function inspectIco(buf) {
  if (buf.length < ICONDIR_SIZE) throw new Error('ICO too short')
  const reserved = buf.readUInt16LE(0)
  const type = buf.readUInt16LE(2)
  const count = buf.readUInt16LE(4)
  if (reserved !== 0) throw new Error(`ICO reserved field is ${reserved}, expected 0`)
  if (type !== 1) throw new Error(`ICO type is ${type}, expected 1`)
  if (count === 0) throw new Error('ICO contains no images')
  const out = []
  for (let i = 0; i < count; i++) {
    const o = ICONDIR_SIZE + i * ICONDIRENTRY_SIZE
    if (o + ICONDIRENTRY_SIZE > buf.length) throw new Error(`ICO directory entry ${i} truncated`)
    const w = buf.readUInt8(o) || 256
    const h = buf.readUInt8(o + 1) || 256
    const planes = buf.readUInt16LE(o + 4)
    const bpp = buf.readUInt16LE(o + 6)
    const bytes = buf.readUInt32LE(o + 8)
    const offset = buf.readUInt32LE(o + 12)
    if (offset + bytes > buf.length) throw new Error(`ICO entry ${i} points past end of file`)
    if (w !== h) throw new Error(`ICO entry ${i} is not square (${w}x${h})`)
    if (planes !== 1 || bpp !== 32) throw new Error(`ICO entry ${i} has planes=${planes} bpp=${bpp}`)
    const data = buf.subarray(offset, offset + bytes)
    let kind = 'unknown'
    if (data.length >= 24 && data.subarray(0, 8).equals(PNG_SIGNATURE)) {
      kind = 'png'
      const pw = data.readUInt32BE(16)
      const ph = data.readUInt32BE(20)
      if (pw !== w || ph !== h) throw new Error(`ICO entry ${i}: directory says ${w}x${h}, PNG IHDR says ${pw}x${ph}`)
    } else if (data.length >= 40 && data.readUInt32LE(0) === 40) {
      kind = 'dib'
    } else {
      throw new Error(`ICO entry ${i} is neither PNG nor DIB`)
    }
    out.push({ size: w, bytes, offset, kind })
  }
  return out
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function formatBytes(n) {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`
}

async function main() {
  const started = Date.now()
  await mkdir(BUILD_DIR, { recursive: true })
  await mkdir(ICONS_DIR, { recursive: true })
  await mkdir(path.dirname(LOGO_PATH), { recursive: true })

  const fullSvg = buildIconSvg({ variant: 'full', background: true, filters: true })
  const simpleSvg = buildIconSvg({ variant: 'simple', background: true, filters: true })
  const traySvg = buildIconSvg({ variant: 'simple', background: false, filters: false })
  const logoSvg = buildIconSvg({ variant: 'full', background: true, filters: false, viewBox: 64, idPrefix: 'vdlogo' })

  // Keep the master SVG next to the PNGs so designers can tweak it.
  await writeFile(path.join(BUILD_DIR, 'icon.svg'), fullSvg, 'utf8')
  await writeFile(LOGO_PATH, logoSvg, 'utf8')

  /** @type {{ size: number, png: Buffer, variant: string }[]} */
  const renders = []
  for (const size of [...ICO_SIZES, ...EXTRA_SIZES]) {
    const variant = size <= SIMPLE_MAX_SIZE ? 'simple' : 'full'
    const png = await renderPng(variant === 'simple' ? simpleSvg : fullSvg, size)
    renders.push({ size, png, variant })
    await writeFile(path.join(ICONS_DIR, `icon-${size}.png`), png)
  }
  const bySize = new Map(renders.map((r) => [r.size, r.png]))

  await writeFile(path.join(BUILD_DIR, 'icon.png'), bySize.get(512))
  await writeFile(path.join(BUILD_DIR, 'icon-256.png'), bySize.get(256))
  await writeFile(path.join(BUILD_DIR, 'icon-1024.png'), bySize.get(1024))

  const tray1x = await renderPng(traySvg, 32)
  const tray2x = await renderPng(traySvg, 64)
  await writeFile(path.join(BUILD_DIR, 'tray.png'), tray1x)
  await writeFile(path.join(BUILD_DIR, 'tray@2x.png'), tray2x)

  const icoEntries = ICO_SIZES.map((size) => ({ size, png: bySize.get(size) }))
  const ico = packIco(icoEntries)
  const icoPath = path.join(BUILD_DIR, 'icon.ico')
  await writeFile(icoPath, ico)

  // Validate by re-reading from disk.
  const readBack = await readFile(icoPath)
  const inspected = inspectIco(readBack)
  const has256 = inspected.some((e) => e.size === 256)
  if (!has256) throw new Error('icon.ico is missing the 256x256 entry required by electron-builder')
  if (readBack.length < 20 * 1024) throw new Error(`icon.ico is suspiciously small (${readBack.length} bytes)`)

  console.log('VibeSync icons generated')
  console.log('')
  console.log(`  ${path.relative(ROOT, icoPath)}  (${formatBytes(readBack.length)}, ${inspected.length} images)`)
  for (const e of inspected) {
    const r = renders.find((x) => x.size === e.size)
    console.log(
      `    ${String(e.size).padStart(3)} x ${String(e.size).padEnd(3)}  ${e.kind.toUpperCase()}  ${formatBytes(e.bytes).padStart(9)}  @${e.offset}  ${r ? r.variant : ''}`
    )
  }
  console.log('')
  for (const rel of ['icon.png', 'icon-256.png', 'icon-1024.png', 'tray.png', 'tray@2x.png', 'icon.svg']) {
    const p = path.join(BUILD_DIR, rel)
    const buf = await readFile(p)
    console.log(`  ${path.relative(ROOT, p).padEnd(24)} ${formatBytes(buf.length)}`)
  }
  console.log(`  ${path.relative(ROOT, LOGO_PATH).padEnd(24)} ${formatBytes(Buffer.byteLength(logoSvg))}`)
  console.log(`  ${path.relative(ROOT, ICONS_DIR)}/icon-<size>.png     ${renders.length} files`)
  console.log('')
  console.log(`Done in ${Date.now() - started} ms`)
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((err) => {
    console.error('Icon generation failed:', err instanceof Error ? err.stack || err.message : err)
    process.exitCode = 1
  })
}
