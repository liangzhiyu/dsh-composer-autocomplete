import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
await mkdir(new URL('artifacts/', root), { recursive: true })
const log = await readFile(new URL('.verification/harness.log', root), 'utf8')
const url = log.match(/http:\/\/127\.0\.0\.1:3087\/\?token=\S+/u)?.[0]
assert.ok(url, 'Start the isolated local Harness instance')
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(15000)
const editor = page.locator('[contenteditable="true"]').first()
const ghost = page.locator('[data-composer-prediction]')
const checks = [], requests = [], errors = []
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => {
  if (new URL(request.url()).pathname === '/composer-autocomplete/v2') requests.push(JSON.parse(request.postData()))
})
const check = name => { checks.push(name); console.log('PASS ' + name) }
const ready = async mode => {
  await page.waitForFunction(mode => document.querySelector(`[data-composer-prediction="${mode}"][data-composer-prediction-state="complete"] kbd`) !== null, mode)
}
try {
  await page.goto(url)
  await editor.waitFor()
  await page.waitForLoadState('networkidle')
  const intro = page.getByRole('button', { name: '继续', exact: true })
  if (await intro.isVisible()) await intro.click()
  const fixture = page.getByRole('button', { name: /选择模型，当前 Autocomplete fixture/u })
  if (!await fixture.isVisible()) {
    await page.getByRole('button', { name: '请选择模型', exact: true }).click()
    await page.getByText('Autocomplete fixture', { exact: true }).last().click()
  }
  assert.ok(await fixture.isVisible(), 'Only use the local fixture')
  await editor.fill('检查补全响应速度')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await ready('next')
  assert.equal(await ghost.getAttribute('title'), '请补充测试用例')
  assert.equal(requests.at(-1).profile, 'fast')
  assert.ok(!(await ghost.innerText()).includes('1/3'))
  const beforeNextReuse = requests.length
  await editor.fill('请补')
  await ready('continue')
  assert.equal(await ghost.getAttribute('title'), '充测试用例')
  await page.waitForTimeout(400)
  assert.equal(requests.length, beforeNextReuse)
  check('Fast mode returns one candidate; typing a next-message prefix reuses its remainder without a model call')

  await editor.fill('Can you also')
  await ready('continue')
  const beforeReuse = requests.length
  await page.evaluate(() => {
    window.__reuseTiming = { draft: '', expected: '', input: null, ready: null }
    let pending = false
    new MutationObserver(() => {
      const t = window.__reuseTiming
      if (document.querySelector('[contenteditable="true"]')?.textContent === t.draft) t.input ??= performance.now()
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        const t = window.__reuseTiming
        const node = document.querySelector('[data-composer-prediction="continue"]')
        if (t.input !== null && node?.title === t.expected && node.getBoundingClientRect().width > 0) t.ready ??= performance.now()
      })
    }).observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true })
  })
  const reuseSamples = []
  const suffix = ' add regression tests'
  for (let i = 1; i <= 6; i++) {
    await page.evaluate(({ draft, expected }) => {
      window.__reuseTiming = { draft, expected, input: null, ready: null }
    }, { draft: 'Can you also' + suffix.slice(0, i), expected: suffix.slice(i) })
    await editor.press(suffix[i - 1] === ' ' ? 'Space' : suffix[i - 1])
    await page.waitForFunction(() => window.__reuseTiming.ready !== null)
    const timing = await page.evaluate(() => window.__reuseTiming)
    reuseSamples.push(timing.ready - timing.input)
  }
  await page.waitForTimeout(400)
  assert.equal(requests.length, beforeReuse)
  assert.equal(await ghost.getAttribute('title'), 'egression tests')
  await editor.press('Tab')
  assert.equal(await editor.innerText(), 'Can you also add regression tests')
  check('English typing-through keeps the exact mid-word suffix and Tab inserts it without an extra space')

  await editor.fill('请继续完善')
  await ready('continue')
  const beforeChinese = requests.length
  await page.keyboard.insertText('并')
  await ready('continue')
  assert.equal(await ghost.getAttribute('title'), '补上回归测试。')
  await page.waitForTimeout(400)
  assert.equal(requests.length, beforeChinese)
  await editor.press('Tab')
  assert.equal(await editor.innerText(), '请继续完善并补上回归测试。')
  check('Chinese typing-through reuses complete candidates with the correct caret and no additional request')

  await editor.fill('请重新分析')
  await ready('continue')
  const beforeMismatch = requests.length
  await editor.press('X')
  await ready('continue')
  assert.ok(requests.length > beforeMismatch)
  assert.equal(requests.at(-1).draft, '请重新分析X')
  assert.deepEqual(errors, [])
  check('An unrelated edit triggers a new scoped prediction; no browser errors')
  const ordered = [...reuseSamples].sort((a, b) => a - b)
  const result = { harness: '0.2.1-rc.2', model: 'deterministic local fixture', browser: await browser.version(),
    checks, reuseInputToReadyMs: Math.round((ordered[2] + ordered[3]) / 2), reuseSamples,
    predictionRequests: requests.length, pageErrors: errors }
  await writeFile(new URL('artifacts/speed-results.json', root), JSON.stringify(result, null, 2) + '\n')
  console.log('Typing-through latency: ' + result.reuseInputToReadyMs + ' ms; no network request')
} catch (error) {
  await page.screenshot({ path: new URL('artifacts/speed-failure.png', root).pathname }).catch(() => {})
  console.log(await page.locator('body').innerText())
  throw error
} finally { await browser.close() }
