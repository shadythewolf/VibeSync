import { describe, expect, it } from 'vitest'
import { cloneSettings, DEFAULT_SETTINGS } from '../../src/shared/settings'
import { readableAlbumArtAccent, themeCssVars } from '../../src/renderer/src/utils/theme'
import { hexToRgb, luminance, paletteFor, resolveTheme, resolveThemeImmediate } from '../../src/renderer/src/visualizer/theme'

describe('album artwork palette placement', () => {
  const colors = { ...DEFAULT_SETTINGS.colors, mode: 'albumArt' as const }

  it('orders colours by brightness independently of extraction order', () => {
    const greyFirst = resolveThemeImmediate(colors, ['#909090', '#F09080'])
    const greyLast = resolveThemeImmediate(colors, ['#F09080', '#909090'])
    expect(greyFirst.colorAt(0)).toBe('#F09080')
    expect(greyFirst.colorAt(1)).toBe('#909090')
    expect(greyLast.colorAt(0)).toBe('#F09080')
    expect(greyLast.colorAt(1)).toBe('#909090')
    expect(greyFirst.stops).toHaveLength(2)
    expect(greyLast.stops).toHaveLength(2)
  })

  it('retains all five extracted colours without inserting duplicate grey stops', () => {
    const palette = ['#F09080', '#3080F0', '#909090', '#20CC70', '#E0C030']
    expect(paletteFor(colors, palette)).toEqual(palette)
  })

  it('limits neutral coverage regardless of whether grey is first, between colours, or last', () => {
    for (const palette of [
      ['#909090','#EE2020','#2040EE'],
      ['#EE2020','#909090','#2040EE'],
      ['#EE2020','#2040EE','#909090']
    ]) {
      const theme = resolveThemeImmediate(colors,palette)
      const neutral = Array.from({length:1000},(_,i)=>theme.colorAt(i/999)).filter(hex => {
        const values = [1,3,5].map(offset=>parseInt(hex.slice(offset,offset+2),16))
        return Math.max(...values)-Math.min(...values)<12
      })
      expect(neutral.length).toBeLessThanOrEqual(100)
      expect(theme.colorAt(0)).toBe([...palette].sort((a,b)=>luminance(b)-luminance(a))[0])
      expect(theme.colorAt(1)).toBe([...palette].sort((a,b)=>luminance(b)-luminance(a))[2])
    }
  })
  it('blends adjacent artwork colours over many bars without large colour jumps', () => {
    const theme = resolveThemeImmediate(colors, ['#65259C','#D6639B','#1A504E','#B1927C','#615A5B'])
    const samples = Array.from({length:256},(_,i)=>hexToRgb(theme.colorAt(i/255)))
    const jumps = samples.slice(1).map((c,i)=>Math.max(Math.abs(c.r-samples[i].r),Math.abs(c.g-samples[i].g),Math.abs(c.b-samples[i].b)))
    expect(Math.max(...jumps)).toBeLessThanOrEqual(16)
    // The broad transition contains many gradual intermediate mixtures.
    const middle = samples.filter(c=>!theme.stops.includes('#'+[c.r,c.g,c.b].map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase()))
    expect(new Set(middle.map(c=>`${c.r},${c.g},${c.b}`)).size).toBeGreaterThan(25)
  })
  it('mixes complementary colours directly instead of travelling through other hues', () => {
    const theme = resolveThemeImmediate(colors, ['#FF0000','#00FFFF'])
    const middle = hexToRgb(theme.colorAt(0.5))
    expect(Math.max(middle.r,middle.g,middle.b)-Math.min(middle.r,middle.g,middle.b)).toBeLessThan(5)
    for (let i=0;i<=100;i++) {
      const c = hexToRgb(theme.colorAt(i/100))
      expect(Math.abs(c.g-c.b)).toBeLessThanOrEqual(1)
      expect(Math.abs(c.r+c.g-255)).toBeLessThanOrEqual(2)
    }
  })
  it('updates the coverage when the same colours occupy different cover areas', () => {
    const blue = Object.defineProperty(['#143CDC','#1ED246'],'weights',{value:[0.9,0.1]})
    const green = Object.defineProperty(['#143CDC','#1ED246'],'weights',{value:[0.1,0.9]})
    resolveTheme(colors,blue,2_000_000)
    const first = resolveTheme(colors,blue,2_001_000)
    expect(hexToRgb(first.colorAt(0.7)).b).toBeGreaterThan(200)
    resolveTheme(colors,green,2_002_000)
    const second = resolveTheme(colors,green,2_003_000)
    expect(hexToRgb(second.colorAt(0.7)).g).toBeGreaterThan(200)
  })
  it('leaves monochrome covers unchanged', () => {
    expect(paletteFor(colors, ['#505050', '#A0A0A0'])).toEqual(['#505050', '#A0A0A0'])
  })

  it('preserves the extracted order after an animated cover transition', () => {
    resolveTheme(colors, ['#505050'], 1_000_000)
    resolveTheme(colors, ['#F09080', '#909090'], 1_002_000)
    const theme = resolveTheme(colors, ['#F09080', '#909090'], 1_003_000)
    expect(theme.stops).toEqual(['#F09080', '#909090'])
    expect(theme.colorAt(0)).toBe('#F09080')
    expect(theme.colorAt(1)).toBe('#909090')
  })
})

describe('album artwork menu contrast', () => {
  it('uses a neutral palette while album artwork is unavailable', () => {
    const settings = cloneSettings(DEFAULT_SETTINGS)
    settings.colors.mode = 'albumArt'
    expect(themeCssVars(settings.colors)['--theme-gradient']).toBe('linear-gradient(90deg, #D1D5DB 0.00%, #9CA3AF 100.00%)')
  })
  it('brightens dark album colours enough for menu text and controls', () => {
    const adjusted = readableAlbumArtAccent('#07152A')
    expect(luminance(adjusted)).toBeGreaterThanOrEqual(0.475)
  })

  it('does not alter colours that are already bright enough', () => {
    expect(readableAlbumArtAccent('#33CCEE')).toBe('#33CCEE')
  })

  it('only adjusts the CSS palette in Album Art mode', () => {
    const settings = cloneSettings(DEFAULT_SETTINGS)
    settings.colors.mode = 'albumArt'
    const albumVars = themeCssVars(settings.colors, ['#07152A', '#182038'])
    expect(albumVars['--accent']).not.toBe('#07152A')
    expect(albumVars['--theme-gradient']).not.toContain('#07152A')

    settings.colors.mode = 'custom'
    settings.colors.primary = '#07152A'
    const customVars = themeCssVars(settings.colors)
    expect(customVars['--accent']).toBe('#07152A')
  })
})
