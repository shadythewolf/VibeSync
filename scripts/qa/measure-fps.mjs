/**
 * Measure the sustained frame rate of the visualizer in the built app.
 *
 *   npm run build
 *   node scripts/qa/measure-fps.mjs                      # development build in out/
 *   node scripts/qa/measure-fps.mjs "<path to VibeSync.exe>"
 *   node scripts/qa/measure-fps.mjs "" --disable-gpu     # software rendering
 *
 * Prints the GPU status plus fps and worst frame time at 1920x1080. Play something
 * through your computer first: an idle visualizer is cheaper to draw than a loud one.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const exe = process.argv[2] || ''
const extra = process.argv.slice(3)
const env = {}
for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string' && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
env.VIBEDECK_USER_DATA = mkdtempSync(join(tmpdir(), 'vibesync-fps-'))

const opts = exe
  ? { executablePath: exe, args: extra, env }
  : { args: [resolve('out/main/index.js'), ...extra], env, cwd: resolve('.') }
const app = await electron.launch(opts)
const page = await app.firstWindow()
await page.waitForSelector('[data-testid=app-root]')
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.setSize(1920, 1080)
  w.center()
})
const cont = page.getByTestId('first-run-continue')
if (await cont.count()) await cont.click()

const gpu = await app.evaluate(({ app }) => app.getGPUFeatureStatus())
console.log('gpu 2d_canvas=' + gpu['2d_canvas'] + ' gpu_compositing=' + gpu.gpu_compositing)

const measure = () =>
  page.evaluate(
    () =>
      new Promise((r) => {
        let n = 0
        let worst = 0
        let last = performance.now()
        const t0 = last
        const tick = () => {
          const now = performance.now()
          const dt = now - last
          last = now
          if (n > 5 && dt > worst) worst = dt
          n++
          if (now - t0 < 3000) requestAnimationFrame(tick)
          else r({ fps: Math.round((n / (now - t0)) * 1000), worstFrameMs: Math.round(worst) })
        }
        requestAnimationFrame(tick)
      })
  )

await page.getByTestId('mode-visualizer').waitFor({ state: 'visible' })
await page.waitForTimeout(1200)
const result = await measure()
console.log(`visualizer: ${result.fps} fps, worst frame ${result.worstFrameMs} ms`)
await app.close()
