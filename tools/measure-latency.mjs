/** Measure the real editor and SSE path with the deterministic local model. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const log = await readFile(new URL('.verification/harness.log', root), 'utf8')
const url = log.match(/http:\/\/127\.0\.0\.1:3087\/\?token=\S+/u)?.[0]
assert.ok(url, 'Start the isolated Harness profile first')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const summaries = []
const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
try {
  const delays = (process.env.DSH_BENCH_DELAYS || '300,150,100').split(',').map(Number)
  const profile = process.env.DSH_BENCH_PROFILE || 'fast'
  assert.ok(['fast', 'balanced'].includes(profile))
  assert.ok(delays.every(delay => Number.isInteger(delay) && delay >= 100 && delay <= 5000))
  for (const debounceMs of delays) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.addInitScript(({ delay, profile }) => {
      localStorage.setItem('dsh-composer-autocomplete.enabled', 'true')
      localStorage.setItem('dsh-composer-autocomplete.options', JSON.stringify({ next: false, continuation: true, debounceMs: delay, profile }))
    }, { delay: debounceMs, profile })
    const page = await context.newPage()
    await page.goto(url)
    const editor = page.locator('[contenteditable="true"]').first()
    await editor.waitFor()
    await page.waitForLoadState('networkidle')
    const intro = page.getByRole('button', { name: '继续', exact: true })
    if (await intro.isVisible()) await intro.click()
    const fixture = page.getByRole('button', { name: /选择模型，当前 Autocomplete fixture/u })
    if (!await fixture.isVisible()) {
      await page.getByRole('button', { name: '请选择模型', exact: true }).click()
      await page.getByText('Autocomplete fixture', { exact: true }).last().click()
    }
    assert.ok(await fixture.isVisible(), 'Only use the isolated fixture model')
    await editor.fill('验证输入框延迟')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await page.getByRole('button', { name: /^已完成，用时/u }).waitFor()

    await page.evaluate(() => {
      window.__autocompleteTiming = null
      const originalFetch = window.fetch
      window.fetch = function(input, init) {
        if (typeof input === 'string' && input.endsWith('/composer-autocomplete/v2') && init?.body) {
          const payload = JSON.parse(init.body)
          const timing = window.__autocompleteTiming
          window.__lastPrediction = { mode: payload.mode, draft: payload.draft, expected: timing?.draft }
          if (timing && payload.mode === 'continue' && payload.draft === timing.draft) timing.request = performance.now()
        }
        return Reflect.apply(originalFetch, this, [input, init])
      }
      let scheduled = false
      new MutationObserver(() => {
        const timing = window.__autocompleteTiming
        if (timing && timing.input === null && document.querySelector('[contenteditable="true"]')?.textContent === timing.draft) {
          timing.input = performance.now()
        }
        if (scheduled) return
        scheduled = true
        requestAnimationFrame(() => {
          scheduled = false
          const timing = window.__autocompleteTiming
          if (!timing || timing.request === null) return
          const ghost = document.querySelector('[data-composer-prediction="continue"]')
          if (!ghost || ghost.getBoundingClientRect().width <= 0 || !ghost.textContent.trim()) return
          timing.first ??= performance.now()
          if (ghost.querySelector('kbd')) timing.ready ??= performance.now()
        })
      }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
    })

    const samples = []
    const runId = Date.now()
    for (let i = 0; i < 6; i++) {
      const draft = `请继续完善模块 ${runId}-${i}`
      await page.evaluate(draft => { window.__autocompleteTiming = { input: null, draft, request: null, first: null, ready: null } }, draft)
      await editor.fill(draft)
      try {
        await page.waitForFunction(() => window.__autocompleteTiming?.ready !== null && window.__autocompleteTiming?.ready !== undefined, null, { timeout: 10000 })
      } catch (error) {
        console.log('Timing diagnostic:', JSON.stringify(await page.evaluate(() => ({
          timing: window.__autocompleteTiming, lastPrediction: window.__lastPrediction,
          ghost: document.querySelector('[data-composer-prediction]')?.textContent,
          editor: document.querySelector('[contenteditable="true"]')?.textContent,
          enabled: localStorage.getItem('dsh-composer-autocomplete.enabled'),
          preferences: localStorage.getItem('dsh-composer-autocomplete.options'),
        }))))
        throw error
      }
      const timing = await page.evaluate(() => window.__autocompleteTiming)
      assert.notEqual(timing.input, null, 'The measurement starts with an observed editor text change')
      assert.notEqual(timing.request, null, 'The measurement includes a real prediction request')
      samples.push({
        inputToRequestMs: timing.request - timing.input,
        requestToFirstMs: timing.first - timing.request,
        inputToFirstMs: timing.first - timing.input,
        inputToReadyMs: timing.ready - timing.input,
      })
    }
    const summary = { profile, debounceMs, count: samples.length, medians: {} }
    for (const key of Object.keys(samples[0])) summary.medians[key] = Math.round(median(samples.map(sample => sample[key])))
    summary.firstRangeMs = [Math.round(Math.min(...samples.map(sample => sample.inputToFirstMs))), Math.round(Math.max(...samples.map(sample => sample.inputToFirstMs)))]
    summary.readyRangeMs = [Math.round(Math.min(...samples.map(sample => sample.inputToReadyMs))), Math.round(Math.max(...samples.map(sample => sample.inputToReadyMs)))]
    summary.samples = samples
    summaries.push(summary)
    console.log(JSON.stringify(summary))
    await context.close()
  }
  await writeFile(new URL('artifacts/latency-results-speed.json', root), JSON.stringify({
    plugin: JSON.parse(await readFile(new URL('package.json', root), 'utf8')).version,
    measuredAt: new Date().toISOString(), model: 'deterministic local fixture; not the DeepSeek cloud API',
    harness: '0.2.1-rc.2', browser: await browser.version(), summaries,
  }, null, 2) + '\n')
} finally {
  await browser.close()
}
