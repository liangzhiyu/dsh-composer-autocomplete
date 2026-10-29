import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const output = new URL('artifacts/', root)
await mkdir(output, { recursive: true })
let startUrl = process.env.DSH_URL || 'http://127.0.0.1:3087/'
try {
  const log = await readFile(new URL('.verification/harness.log', root), 'utf8')
  const local = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/u)?.[0]
  if (local && new URL(local).origin === new URL(startUrl).origin) startUrl = local
} catch (error) { if (error.code !== 'ENOENT') throw error }
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(startUrl).hostname), 'Use an isolated local test profile')

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(15000)
const errors = [], checks = [], requests = [], responses = [], sessions = {}
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => {
  if (new URL(request.url()).pathname === '/composer-autocomplete/v2') requests.push(JSON.parse(request.postData()))
})
page.on('response', response => {
  if (new URL(response.url()).pathname !== '/composer-autocomplete/v2') return
  const body = JSON.parse(response.request().postData())
  responses.push(response.text().then(text => ({ ...body, text })).catch(() => null))
})
const editor = page.locator('[contenteditable="true"]').first()
const ghost = page.locator('[data-composer-prediction]')
const check = name => { checks.push(name); console.log('PASS ' + name) }
const ready = async (scope, prefix = '检查') => {
  await page.waitForFunction(({ scope, prefix }) => {
    const node = document.querySelector('[data-composer-prediction="next"][data-composer-prediction-state="complete"]')
    return node?.textContent.includes(`${prefix} ${scope} 会话的测试`)
  }, { scope, prefix })
  const id = await ghost.getAttribute('data-composer-prediction-session')
  if (sessions[scope]) assert.equal(id, sessions[scope])
  else sessions[scope] = id
  assert.equal((await editor.innerText()).trim(), '')
}
const open = async scope => {
  await page.getByText(`${scope} 会话：本地验证回复已完成。`, { exact: true }).first().click()
  await page.waitForFunction(id => document.querySelector('[data-composer-prediction-anchor]')?.getAttribute('data-composer-prediction-session') === id, sessions[scope])
}

try {
  await page.goto(startUrl)
  await editor.waitFor()
  await page.waitForLoadState('networkidle')
  const intro = page.getByRole('button', { name: '继续', exact: true })
  if (await intro.isVisible()) await intro.click()
  await page.evaluate(() => {
    localStorage.setItem('dsh-composer-autocomplete.enabled', 'true')
    localStorage.setItem('dsh-composer-autocomplete.options', JSON.stringify({ next: true, continuation: true, debounceMs: 300 }))
  })
  await page.reload()
  await editor.waitFor()
  await page.waitForLoadState('networkidle')
  const fixture = page.getByRole('button', { name: /选择模型，当前 Autocomplete fixture/u })
  if (!await fixture.isVisible()) {
    await page.getByRole('button', { name: '请选择模型', exact: true }).click()
    await page.getByText('Autocomplete fixture', { exact: true }).last().click()
  }
  assert.ok(await fixture.isVisible(), 'Only the local fixture receives test messages')
  for (const scope of ['ALPHA', 'BETA']) {
    if (scope === 'BETA') {
      await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
      // The native new-session transition can complete after the click promise.
      await page.getByText('探索未至之境', { exact: true }).waitFor()
      await page.waitForTimeout(1000)
    }
    await editor.fill(`SESSION_${scope} 请检查此会话的任务`)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await ready(scope)
  }
  assert.notEqual(sessions.ALPHA, sessions.BETA)
  for (const scope of ['ALPHA', 'BETA', 'ALPHA', 'BETA', 'ALPHA']) {
    await open(scope)
    await ready(scope)
  }
  const completed = (await Promise.all(responses)).filter(Boolean)
  assert.ok(completed.some(r => r.sessionId === sessions.ALPHA && r.text.includes('"cached":true')))
  assert.ok(completed.some(r => r.sessionId === sessions.BETA && r.text.includes('"cached":true')))
  check('A → B → A repeated navigation restores only each session’s own cached suggestions')

  await editor.fill('RACE_DELAY 请继续完善')
  await page.waitForFunction(() => document.querySelector('[data-composer-prediction-anchor]') !== null)
  // Wait for the actual request rather than for a guessed debounce duration.
  const deadline = Date.now() + 10000
  while (!requests.some(r => r.sessionId === sessions.ALPHA && r.draft.startsWith('RACE_DELAY'))) {
    assert.ok(Date.now() < deadline, 'Slow alpha prediction must start')
    await page.waitForTimeout(25)
  }
  await open('BETA')
  await ready('BETA')
  await page.waitForTimeout(1800)
  assert.ok((await ghost.innerText()).includes('BETA'))
  assert.ok(!(await ghost.innerText()).includes('ALPHA'))
  await editor.click()
  await editor.press('Tab')
  assert.equal(await editor.innerText(), '检查 BETA 会话的测试')
  check('Switching during a slow prediction cancels alpha; Tab inserts only beta into beta’s draft')

  await editor.fill('')
  // Wait for Harness to publish the empty draft before navigating away.
  // The DOM can clear before its per-session draft store has updated.
  await ready('BETA')
  await open('ALPHA')
  assert.equal(await editor.innerText(), 'RACE_DELAY 请继续完善')
  await editor.fill('SESSION_ALPHA_UPDATED 请复核更新后的任务')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await ready('ALPHA', '复核')
  await open('BETA')
  await ready('BETA')
  await open('ALPHA')
  await ready('ALPHA', '复核')
  check('A new turn invalidates the old alpha cache while beta’s cache stays isolated')

  await page.screenshot({ path: fileURLToPath(new URL('session-switch.png', output)) })
  assert.deepEqual(errors, [])
  check('Session switching preserves drafts and produces no browser errors')
  await writeFile(new URL('session-switch-results.json', output), JSON.stringify({
    harness: '0.2.1-rc.2', model: 'deterministic local fixture', browser: await browser.version(),
    checks, predictionRequests: requests.length, pageErrors: errors,
  }, null, 2) + '\n')
} catch (error) {
  await page.screenshot({ path: fileURLToPath(new URL('session-switch-failure.png', output)) }).catch(() => {})
  await writeFile(new URL('session-switch-failure.txt', output), await page.locator('body').innerText()).catch(() => {})
  throw error
} finally { await browser.close() }
