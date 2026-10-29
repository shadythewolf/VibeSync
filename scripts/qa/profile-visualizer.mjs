/**
 * Profile visualizer smoothness in the built app: frame pacing, long tasks and how evenly
 * audio chunks arrive. measure-fps.mjs reports averages; choppiness hides in the tail.
 *
 *   npm run build
 *   node scripts/qa/profile-visualizer.mjs                    # development build in out/
 *   node scripts/qa/profile-visualizer.mjs "<VibeSync.exe>"
 *   node scripts/qa/profile-visualizer.mjs "" --seconds=20
 *
 * Play music first: an idle visualizer draws far less than a loud one.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const exe = args[0] && !args[0].startsWith('--') ? args[0] : ''
const seconds = Number((args.find((a) => a.startsWith('--seconds=')) ?? '--seconds=10').split('=')[1])
const extra = args.filter((a) => a !== exe && !a.startsWith('--seconds='))

const env = {}
for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string' && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
env.VIBEDECK_USER_DATA = mkdtempSync(join(tmpdir(), 'vibesync-profile-'))

const app = await electron.launch(
  exe ? { executablePath: exe, args: extra, env } : { args: [resolve('out/main/index.js'), ...extra], env, cwd: resolve('.') }
)
const page = await app.firstWindow()
await page.waitForSelector('[data-testid=app-root]')
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.setSize(1920, 1080)
  w.center()
})
const cont = page.getByTestId('first-run-continue')
if (await cont.count()) await cont.click()
await page.getByTestId('mode-visualizer').waitFor({ state: 'visible' })
await page.waitForTimeout(1500)

const gpu = await app.evaluate(({ app }) => app.getGPUFeatureStatus())
const result = await page.evaluate(
  (ms) =>
    new Promise((done) => {
      const frames = []
      const chunks = []
      const longTasks = []
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longTasks.push(Math.round(e.duration))
      }).observe({ type: 'longtask', buffered: false })
      window.vibedeck.audio.onPcm((c) => chunks.push({ t: performance.now(), frames: c.frames, rate: c.sampleRate }))
      const t0 = performance.now()
      let last = t0
      const tick = (now) => {
        frames.push(now - last)
        last = now
        if (now - t0 < ms) requestAnimationFrame(tick)
        else done({ frames: frames.slice(2), chunks, longTasks, hz: Math.round(1000 / median(frames.slice(2))) })
      }
      const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1]
      requestAnimationFrame(tick)
    }),
  seconds * 1000
)
await app.close()

const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const f = result.frames
const budget = 1000 / result.hz
const late = f.filter((d) => d > budget * 1.5).length
console.log(`gpu 2d_canvas=${gpu['2d_canvas']} gpu_compositing=${gpu.gpu_compositing}`)
console.log(`display ~${result.hz} Hz, ${f.length} frames in ${seconds}s`)
console.log(
  `frame ms  p50 ${pct(f, 50).toFixed(1)}  p95 ${pct(f, 95).toFixed(1)}  p99 ${pct(f, 99).toFixed(1)}  max ${Math.max(...f).toFixed(1)}`
)
console.log(`late frames (>1.5x budget): ${late} (${((late / f.length) * 100).toFixed(1)}%)`)
console.log(`long tasks (>50 ms): ${result.longTasks.length}${result.longTasks.length ? ' [' + result.longTasks.join(', ') + ']' : ''}`)

const c = result.chunks
if (c.length < 2) {
  console.log('audio chunks: none received - is something playing?')
} else {
  const gaps = c.slice(1).map((x, i) => x.t - c[i].t)
  const audioMs = c.map((x) => (x.frames / x.rate) * 1000)
  console.log(`audio chunks: ${c.length}, ~${pct(audioMs, 50).toFixed(1)} ms of audio each`)
  console.log(
    `chunk arrival gap ms  p50 ${pct(gaps, 50).toFixed(1)}  p95 ${pct(gaps, 95).toFixed(1)}  p99 ${pct(gaps, 99).toFixed(1)}  max ${Math.max(...gaps).toFixed(1)}`
  )
  const bunched = gaps.filter((g) => g < 2).length
  console.log(`chunks arriving <2 ms after the previous one (bunched): ${bunched} (${((bunched / gaps.length) * 100).toFixed(1)}%)`)
}
