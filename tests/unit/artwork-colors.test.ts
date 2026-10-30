import { describe, expect, it } from 'vitest'
import { extractPaletteFromPixels } from '../../src/renderer/src/visualizer/artworkColors'
import coverHistogram from '../fixtures/alan-wake-cover-histogram.json'
import saltHistogram from '../fixtures/salt-and-silence-cover-histogram.json'
import breakTheWallsHistogram from '../fixtures/break-the-walls-cover-histogram.json'
import nibiruHistogram from '../fixtures/nibiru-cover-histogram.json'
import rushHistogram from '../fixtures/rush-over-me-cover-histogram.json'
import neutralizedHistogram from '../fixtures/neutralized-cover-histogram.json'
import starstormHistogram from '../fixtures/starstorm-cover-histogram.json'
import neverSayDieHistogram from '../fixtures/never-say-die-7-cover-histogram.json'
import reJadedHistogram from '../fixtures/re-jaded-cover-histogram.json'
import fallApartHistogram from '../fixtures/fall-apart-cover-histogram.json'
import { hexToRgb, isNeutralColor, luminance, paletteFor, resolveThemeImmediate } from '../../src/renderer/src/visualizer/theme'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'

function pixels(colors: Array<[number, number, number]>, repeats = 20): Uint8ClampedArray {
  const data = new Uint8ClampedArray(colors.length * repeats * 4)
  let offset = 0
  for (const color of colors) {
    for (let i = 0; i < repeats; i++) {
      data[offset++] = color[0]
      data[offset++] = color[1]
      data[offset++] = color[2]
      data[offset++] = 255
    }
  }
  return data
}

describe('album artwork colour extraction', () => {
  it('keeps the textured red from the supplied Alan Wake cover', () => {
    const data = Uint8ClampedArray.from(coverHistogram.flatMap(([r,g,b,a,count]) => Array.from({length:count},()=>[r,g,b,a]).flat()))
    const palette = extractPaletteFromPixels(data)
    const red = hexToRgb(palette[0])
    expect(red.r).toBeGreaterThan(red.g * 1.7)
    expect(red.r).toBeGreaterThan(red.b * 1.5)
    expect(isNeutralColor(red)).toBe(false)
    expect(palette.some(color => isNeutralColor(hexToRgb(color)))).toBe(true)
    const stops = paletteFor({...DEFAULT_SETTINGS.colors,mode:'albumArt'},palette)
    expect(stops).toEqual(palette)
    expect(stops.length).toBeLessThanOrEqual(5)
  })
  it('retains the real grey shades from Fall Apart alongside red without duplicating them', () => {
    const data = Uint8ClampedArray.from(fallApartHistogram.flatMap(([r,g,b,a,count]) => Array.from({length:count},()=>[r,g,b,a]).flat()))
    const palette = extractPaletteFromPixels(data)
    const theme = resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},palette)
    expect(theme.stops).toEqual(palette)
    expect(theme.stops.some(color => isNeutralColor(hexToRgb(color)) && hexToRgb(color).r > 20 && hexToRgb(color).r < 120)).toBe(true)
    const red=Array.from({length:1000},(_,i)=>hexToRgb(theme.colorAt(i/999))).find(c=>c.r>c.g*1.7)!
    expect(red).toBeDefined()
    expect(red.r).toBeGreaterThan(red.g*1.7)
    expect(new Set(theme.stops).size).toBe(theme.stops.length)
  })
  it('keeps turquoise from the supplied Starstorm cover instead of spending slots on purple shades and grey', () => {
    const data = Uint8ClampedArray.from(starstormHistogram.flatMap(([r,g,b,a,count]) => Array.from({length:count},()=>[r,g,b,a]).flat()))
    const palette = extractPaletteFromPixels(data)
    const rgb = palette.map(hexToRgb)
    expect(palette).toHaveLength(5)
    expect(rgb.filter(isNeutralColor)).toHaveLength(1)
    expect(rgb.some(c => c.g > c.r * 1.5 && c.b > c.r * 1.5)).toBe(true)
    expect(rgb.some(c => c.b > c.g * 1.5 && c.r > c.g)).toBe(true)
    expect(rgb.some(c => c.r > c.g * 1.5 && c.b > c.g)).toBe(true)
    const theme = resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},palette)
    const samples = Array.from({length:1000},(_,i)=>hexToRgb(theme.colorAt(i/999)))
    expect(samples.filter(isNeutralColor).length).toBeLessThanOrEqual(120)
    const turquoise = samples.filter(c => c.g > c.r*1.5 && c.b > c.r*1.5).length / samples.length
    const share = rgb.reduce((sum,c,i)=>sum+(c.g>c.r*1.5&&c.b>c.r*1.5?palette.weights![i]:0),0)
    expect(turquoise).toBeGreaterThan(share * 0.4)
    expect(turquoise).toBeLessThan(share * 1.5)
  })
  it('keeps the supplied Salt and Silence cover dark blue without pale grey bands', () => {
    const data=Uint8ClampedArray.from(saltHistogram.flatMap(([r,g,b,a,count])=>Array.from({length:count},()=>[r,g,b,a]).flat()))
    const palette=extractPaletteFromPixels(data)
    expect(palette.every(hex=>!isNeutralColor(hexToRgb(hex)))).toBe(true)
    const theme=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},palette)
    const samples=Array.from({length:1000},(_,i)=>hexToRgb(theme.colorAt(i/999)))
    expect(samples.every(c=>c.b>c.r*1.5 && c.b>c.g*1.5)).toBe(true)
    expect(samples.every(c=>c.b>=105 && c.b<=120)).toBe(true)
  })
  it('keeps the near-black teal of the supplied Break The Walls cover dark next to its bright red', () => {
    const data=Uint8ClampedArray.from(breakTheWallsHistogram.flatMap(([r,g,b,a,count])=>Array.from({length:count},()=>[r,g,b,a]).flat()))
    const palette=extractPaletteFromPixels(data)
    const theme=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},palette)
    const samples=Array.from({length:1000},(_,i)=>hexToRgb(theme.colorAt(i/999)))
    const teal=samples.filter(c=>c.g>c.r*2 && c.b>c.r*2)
    const red=samples.filter(c=>c.r>c.g*2 && c.r>c.b*2)
    expect(teal.length).toBeGreaterThan(300)
    expect(red.length).toBeGreaterThan(300)
    // Lifting the black background to the full minimum made it a mid teal (#0B7069).
    expect(teal.every(c=>Math.max(c.r,c.g,c.b)>=56 && Math.max(c.r,c.g,c.b)<=72)).toBe(true)
    expect(hexToRgb(theme.colorAt(0)).r).toBeGreaterThanOrEqual(230)
  })
  it.each([[1,1,2],[2,1,1],[1,2,1],[0,0,1],[0,2,1],[3,2,1]])('does not amplify near-black channel noise into a saturated colour: %j', (r,g,b) => {
    const palette=extractPaletteFromPixels(pixels([[r,g,b]]))
    const theme=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},palette)
    expect(isNeutralColor({r,g,b})).toBe(true)
    for(const level of [0,1]) {
      const c=hexToRgb(theme.barColor(1,3,level))
      expect(Math.max(c.r,c.g,c.b)-Math.min(c.r,c.g,c.b)).toBeLessThanOrEqual(2)
      expect(Math.min(c.r,c.g,c.b)).toBeGreaterThanOrEqual(36)
    }
  })
  it('keeps near-black neutral coverage alongside a small coloured accent',()=>{
    const palette=extractPaletteFromPixels(new Uint8ClampedArray([...pixels([[1,1,2]],95),...pixels([[180,30,20]],5)]))
    const neutral=palette.findIndex(hex=>isNeutralColor(hexToRgb(hex)))
    expect(neutral).toBeGreaterThanOrEqual(0)
    expect(palette.weights![neutral]).toBeCloseTo(0.95)
    const theme=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},palette)
    const samples=Array.from({length:1000},(_,i)=>hexToRgb(theme.colorAt(i/999)))
    expect(samples.filter(isNeutralColor).length).toBeGreaterThan(850)
  })
  it.each([[2,0,3],[3,2,0],[0,3,2],[4,0,0],[0,4,0],[0,0,4]])('keeps black-floor colour casts subdued across channels: %j', (r,g,b)=>{
    expect(isNeutralColor({r,g,b})).toBe(true)
    const theme=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},extractPaletteFromPixels(pixels([[r,g,b]])))
    for(const level of [0,1]) {
      const c=hexToRgb(theme.barColor(0,1,level))
      expect(Math.max(c.r,c.g,c.b)-Math.min(c.r,c.g,c.b)).toBeLessThanOrEqual(4)
      expect(isNeutralColor(c)).toBe(true)
    }
  })
  it('sorts one measured artwork gradient from bright to dark without changing area shares',()=>{
    const data=new Uint8ClampedArray([...pixels([[20,20,20]],80),...pixels([[240,200,80]],15),...pixels([[80,80,180]],5)])
    const palette=extractPaletteFromPixels(data),weights=[...palette.weights!]
    const theme=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},palette)
    const samples=Array.from({length:1000},(_,i)=>theme.colorAt(i/999))
    for(let i=1;i<samples.length;i++)expect(luminance(samples[i])-luminance(samples[i-1])).toBeLessThanOrEqual(1/255)
    expect(palette.weights).toEqual(weights)
    expect(hexToRgb(samples[0]).r).toBeGreaterThan(200)
    expect(luminance(samples.at(-1)!)).toBeLessThan(0.2)
    expect(samples.filter(hex=>isNeutralColor(hexToRgb(hex))).length).toBeGreaterThan(750)
  })
  it('retains the small blue-violet family in Never Say Die Vol. 7',()=>{
    const data=Uint8ClampedArray.from(neverSayDieHistogram.flatMap(([r,g,b,a,n])=>Array.from({length:n},()=>[r,g,b,a]).flat()))
    const palette=extractPaletteFromPixels(data)
    const index=palette.findIndex(hex=>{const c=hexToRgb(hex);return c.b>c.r*1.2&&c.b>c.g*1.2})
    expect(index).toBeGreaterThanOrEqual(0)
    expect(palette.weights![index]).toBeGreaterThan(0.015)
    expect(palette.weights![index]).toBeLessThan(0.06)
    expect(palette.length).toBeLessThanOrEqual(5)
    expect(palette.some(hex=>isNeutralColor(hexToRgb(hex)))).toBe(true)
  })
  it('recognizes neighbouring sub-percent shades as one accent but rejects isolated noise',()=>{
    const data=new Uint8ClampedArray([...pixels([[20,20,20]],980),...pixels([[80,60,180]],6),...pixels([[60,65,190]],6),...pixels([[20,160,30]],3)])
    const palette=extractPaletteFromPixels(data)
    expect(palette.some(hex=>{const c=hexToRgb(hex);return c.b>c.r*1.4&&c.b>c.g*1.4})).toBe(true)
    expect(palette.some(hex=>{const c=hexToRgb(hex);return c.g>c.r*1.4&&c.g>c.b*1.4})).toBe(false)
  })
  it('keeps Re_Jaded black regions dark even at individual bar peaks',()=>{
    const data=Uint8ClampedArray.from(reJadedHistogram.flatMap(([r,g,b,a,count])=>Array.from({length:count},()=>[r,g,b,a]).flat()))
    const theme=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},extractPaletteFromPixels(data))
    const quiet:ReturnType<typeof hexToRgb>[]=[],peaks:ReturnType<typeof hexToRgb>[]=[]
    for(let i=0;i<1000;i++) {
      const c=hexToRgb(theme.barColor(i,1000,0))
      if(isNeutralColor(c)){quiet.push(c);peaks.push(hexToRgb(theme.barColor(i,1000,1)))}
    }
    expect(quiet.length).toBeGreaterThan(650)
    expect(quiet.filter(c=>Math.max(c.r,c.g,c.b)<=42).length).toBeGreaterThan(700)
    expect(quiet.every(c=>Math.max(c.r,c.g,c.b)<=50)).toBe(true)
    expect(peaks.filter(c=>Math.max(c.r,c.g,c.b)<=56).length).toBeGreaterThan(700)
    expect(peaks.every(c=>Math.max(c.r,c.g,c.b)<=70)).toBe(true)
    expect(peaks.some((c,i)=>c.r>quiet[i].r)).toBe(true)
  })
  it('keeps existing visible grey and coloured bar highlights',()=>{
    const grey=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},['#606060'])
    expect(grey.colorAt(0)).toBe('#606060')
    expect(hexToRgb(grey.barColor(0,1,1)).r).toBeGreaterThan(140)
    const custom=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'custom',primary:'#101010',secondary:'#101010'})
    expect(custom.colorAt(0)).toBe('#101010')
    expect(hexToRgb(custom.barColor(0,1,1)).r).toBeGreaterThan(90)
  })
  it('keeps Re_Jaded predominantly neutral with its green accent instead of purple',()=>{
    const data=Uint8ClampedArray.from(reJadedHistogram.flatMap(([r,g,b,a,count])=>Array.from({length:count},()=>[r,g,b,a]).flat()))
    const palette=extractPaletteFromPixels(data)
    const theme=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},palette)
    const samples=Array.from({length:1000},(_,i)=>hexToRgb(theme.colorAt(i/999)))
    expect(samples.filter(isNeutralColor).length).toBeGreaterThan(650)
    expect(samples.filter(c=>c.g>c.r*1.3&&c.g>c.b*1.3).length).toBeGreaterThan(100)
    expect(samples.filter(c=>c.r>c.g*1.4&&c.b>c.g*1.4).length).toBeLessThan(30)
    expect(palette.length).toBeLessThanOrEqual(5)
  })
  it('introduces chromatic amplification smoothly above the black floor',()=>{
    for(const channel of ['r','g','b'] as const) {
      let previous:ReturnType<typeof hexToRgb>|undefined
      for(let value=0;value<=20;value++) {
        const source={r:0,g:0,b:0,[channel]:value}
        const hex='#'+[source.r,source.g,source.b].map(v=>v.toString(16).padStart(2,'0')).join('')
        const c=hexToRgb(resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},[hex]).colorAt(0))
        if(previous)expect(Math.max(Math.abs(c.r-previous.r),Math.abs(c.g-previous.g),Math.abs(c.b-previous.b))).toBeLessThanOrEqual(8)
        previous=c
      }
    }
    const c=hexToRgb(resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},['#020205']).colorAt(0))
    expect(Math.max(c.r,c.g,c.b)-Math.min(c.r,c.g,c.b)).toBeLessThanOrEqual(4)
  })
  it.each([[5,6,12],[12,15,25],[5,12,6],[12,5,6]])('does not turn chromatic shadows into neutral grey: %j', (r,g,b) => {
    const rgb={r,g,b}
    expect(isNeutralColor(rgb)).toBe(false)
    const palette=extractPaletteFromPixels(pixels([[r,g,b],[80,100,180]]))
    expect(palette.every(hex=>!isNeutralColor(hexToRgb(hex)))).toBe(true)
    const theme=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},palette)
    for(const t of [0,1])expect(isNeutralColor(hexToRgb(theme.colorAt(t)))).toBe(false)
  })
  it.each([[10,12,11],[60,65,63],[130,135,133]])('still treats subtle real grey tints as neutral: %j', (r,g,b) => {
    expect(isNeutralColor({r,g,b})).toBe(true)
  })
  it('preserves the dark background and small fire accent in the supplied Nibiru cover', () => {
    const data=Uint8ClampedArray.from(nibiruHistogram.flatMap(([r,g,b,a,count])=>Array.from({length:count},()=>[r,g,b,a]).flat()))
    const palette=extractPaletteFromPixels(data)
    const neutral=palette.findIndex(hex=>isNeutralColor(hexToRgb(hex)))
    expect(palette.weights![neutral]).toBeGreaterThan(0.8)
    expect(Math.max(...Object.values(hexToRgb(palette[neutral])))).toBeLessThan(50)
    const theme=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},palette)
    const samples=Array.from({length:1000},(_,i)=>hexToRgb(theme.colorAt(i/999)))
    expect(samples.filter(c=>isNeutralColor(c) && Math.max(c.r,c.g,c.b)<80).length).toBeGreaterThan(750)
    expect(samples.every(c=>Math.max(c.r,c.g,c.b)>=36)).toBe(true)
    expect(samples.filter(c=>c.r>c.g*1.4 && c.g>c.b).length).toBeGreaterThan(70)
  })
  it('does not replace a black majority with the brightest neutral detail', () => {
    const data=new Uint8ClampedArray([...pixels([[0,0,0]],85),...pixels([[255,255,255]],5),...pixels([[220,80,20]],10)])
    const palette=extractPaletteFromPixels(data)
    const neutral=palette.findIndex(hex=>isNeutralColor(hexToRgb(hex)))
    expect(palette.weights![neutral]).toBeCloseTo(0.9)
    expect(hexToRgb(palette[neutral]).r).toBeLessThan(20)
    const theme=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},palette)
    const c=hexToRgb(theme.colorAt(0.6))
    expect(c.r).toBe(38)
    expect(c.g).toBe(38)
    expect(c.b).toBe(38)
  })
  it('keeps dark monochrome area weighted and visible', () => {
    const palette=extractPaletteFromPixels(new Uint8ClampedArray([...pixels([[0,0,0]],95),...pixels([[255,255,255]],5)]))
    const theme=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},palette)
    expect(theme.colorAt(0.5)).toBe('#262626')
    expect(theme.colorAt(0)).toBe('#FFFFFF')
    expect(theme.colorAt(1)).toBe('#262626')
  })
  it('raises dark blue visibility without changing its channel ratios or custom colours', () => {
    const album=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},['#041020'])
    const c=hexToRgb(album.colorAt(0))
    expect(c.b/c.g).toBeCloseTo(2,1)
    expect(c.g/c.r).toBeCloseTo(4,0)
    expect(c.b).toBe(112)
    const custom=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'custom',primary:'#041020',secondary:'#041020'})
    expect(custom.colorAt(0)).toBe('#041020')
  })
  it('retains blue, teal and pale green from the supplied Rush Over Me cover', () => {
    const data=Uint8ClampedArray.from(rushHistogram.flatMap(([r,g,b,a,count])=>Array.from({length:count},()=>[r,g,b,a]).flat()))
    const palette=extractPaletteFromPixels(data)
    const rgb=palette.map(hexToRgb)
    expect(palette.length).toBeGreaterThanOrEqual(3)
    expect(rgb.some(c=>c.b>c.g*1.2 && c.g>c.r*1.2)).toBe(true)
    expect(rgb.some(c=>c.g>c.b*1.1 && c.g>c.r*1.5)).toBe(true)
    expect(rgb.some(c=>c.g>180 && c.g>c.b && c.b>c.r)).toBe(true)
    expect(palette.weights!.reduce((a,b)=>a+b,0)).toBeCloseTo(1)
    const theme=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},palette)
    const samples=Array.from({length:1000},(_,i)=>hexToRgb(theme.colorAt(i/999)))
    expect(samples.filter(c=>c.b>c.g*1.2).length).toBeGreaterThan(30)
    expect(samples.filter(c=>c.g>c.b*1.1).length).toBeGreaterThan(80)
  })
  it.each([
    [[220,40,40],[220,120,40]],
    [[40,220,40],[40,220,120]],
    [[40,40,220],[120,40,220]],
    [[40,160,220],[40,220,220]]
  ])('preserves adjacent distinct hues across the colour wheel: %j and %j', (a,b) => {
    const palette=extractPaletteFromPixels(pixels([a as [number,number,number],b as [number,number,number]]))
    expect(palette).toHaveLength(2)
    expect(palette.weights).toEqual([0.5,0.5])
  })
  it('preserves a 90 percent blue cover with a small green region', () => {
    const data = new Uint8ClampedArray([...pixels([[20,60,220]],90),...pixels([[30,210,70]],10)])
    const palette = extractPaletteFromPixels(data)
    expect(palette.weights?.[palette.indexOf('#143CDC')]).toBeCloseTo(0.9)
    const theme = resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},palette)
    const samples = Array.from({length:1000},(_,i)=>hexToRgb(theme.colorAt(i/999)))
    const green = samples.filter(c=>c.g>c.b && c.g>c.r).length
    expect(green).toBeGreaterThan(50)
    expect(green).toBeLessThan(160)
    expect(hexToRgb(theme.colorAt(0.7)).b).toBeGreaterThan(200)
  })
  it('retains the neutral majority and small red accent in the supplied Neutralized cover', () => {
    const data=Uint8ClampedArray.from(neutralizedHistogram.flatMap(([r,g,b,a,count])=>Array.from({length:count},()=>[r,g,b,a]).flat()))
    const palette=extractPaletteFromPixels(data)
    const theme=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},palette)
    const samples=Array.from({length:1000},(_,i)=>hexToRgb(theme.colorAt(i/999)))
    expect(samples.filter(isNeutralColor).length).toBeGreaterThan(800)
    expect(samples.filter(c=>c.r>c.g*1.4&&c.r>c.b*1.4).length).toBeLessThan(150)
    expect(palette.some(hex=>{const c=hexToRgb(hex);return c.r>c.g*1.4&&c.r>c.b*1.4})).toBe(true)
  })
  it('does not discard the white majority in a white cover with a small red detail', () => {
    const data=new Uint8ClampedArray([...pixels([[255,255,255]],95),...pixels([[220,30,30]],5)])
    const palette=extractPaletteFromPixels(data)
    expect(palette.weights?.[palette.indexOf('#FFFFFF')]).toBeCloseTo(0.95)
    const theme=resolveThemeImmediate({...DEFAULT_SETTINGS.colors,mode:'albumArt'},palette)
    const samples=Array.from({length:1000},(_,i)=>hexToRgb(theme.colorAt(i/999)))
    expect(samples.filter(c=>c.r>c.g*1.4).length).toBeLessThan(100)
    expect(samples.filter(isNeutralColor).length).toBeGreaterThan(850)
  })
  it('keeps five distinct colour regions in a colourful cover', () => {
    const palette = extractPaletteFromPixels(pixels([[255,0,0],[0,255,0],[0,0,255],[255,255,0],[0,255,255]]))
    expect(palette).toHaveLength(5)
    expect(palette).toEqual(expect.arrayContaining(['#FF0000','#00FF00','#0000FF','#FFFF00','#00FFFF']))
  })
  it('limits covers with more colour regions to five representative colours', () => {
    const palette = extractPaletteFromPixels(pixels([[255,0,0],[0,255,0],[0,0,255],[255,255,0],[0,255,255],[255,0,255]]))
    expect(palette).toHaveLength(5)
    expect(new Set(palette).size).toBe(5)
  })
  it('merges similar shades instead of forcing five colours', () => {
    const palette = extractPaletteFromPixels(pixels([[240, 40, 40], [30, 210, 90], [40, 90, 235], [245, 45, 45]]))
    expect(palette).toHaveLength(3)
    expect(new Set(palette).size).toBe(3)
    expect(palette.every((color) => /^#[0-9A-F]{6}$/.test(color))).toBe(true)
  })

  it('retains nearly black area alongside colour while filtering transparent pixels', () => {
    const data = pixels([[2, 2, 2], [110, 112, 111], [20, 180, 220]])
    data[3] = 0
    const palette=extractPaletteFromPixels(data)
    expect(palette).toEqual(['#14B4DC', '#393A3A'])
    expect(palette.weights![1]).toBeCloseTo(39/59)
  })

  it('keeps a dominant grey region in a mixed grey and red cover', () => {
    const data = new Uint8ClampedArray([...pixels([[130, 130, 130]], 100), ...pixels([[220, 40, 40]], 40)])
    const palette = extractPaletteFromPixels(data)
    expect(palette).toHaveLength(2)
    expect(palette).toEqual(expect.arrayContaining(['#828282', '#DC2828']))
  })

  it('keeps grey even when a coloured region has a similar brightness', () => {
    const palette = extractPaletteFromPixels(pixels([[144, 144, 144], [240, 144, 128]]))
    expect(palette).toEqual(['#F09080', '#909090'])
  })

  it('preserves monochrome artwork instead of dropping its palette', () => {
    const palette = extractPaletteFromPixels(pixels([[0, 0, 0], [80, 80, 80], [250, 250, 250]]))
    expect(palette).toContain('#505050')
    expect(palette.every(color => color.slice(1, 3) === color.slice(3, 5) && color.slice(3, 5) === color.slice(5, 7))).toBe(true)
  })

  it('preserves very dark and very bright single-colour covers', () => {
    expect(extractPaletteFromPixels(pixels([[4, 1, 1]]))).toEqual(['#040101'])
    expect(extractPaletteFromPixels(pixels([[255, 255, 255]]))).toEqual(['#FFFFFF'])
  })

  it('returns no palette only when there are no opaque pixels', () => {
    expect(extractPaletteFromPixels(new Uint8ClampedArray())).toEqual([])
    const transparent = pixels([[220, 40, 40]])
    for(let i=3;i<transparent.length;i+=4)transparent[i]=0
    expect(extractPaletteFromPixels(transparent)).toEqual([])
  })
})
