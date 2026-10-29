/** Capture the installed plugin in the isolated Harness profile. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const output = new URL('artifacts/', root)
await mkdir(output, { recursive: true })
const log = await readFile(new URL('.verification/harness.log', root), 'utf8')
const url = log.match(/http:\/\/127\.0\.0\.1:3087\/\?token=\S+/u)?.[0]
assert.ok(url, 'Start the isolated Harness profile on port 3087 first')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', error => errors.push(error.message))
const save = async (locator, name) => locator.screenshot({ path: fileURLToPath(new URL(name, output)) })

try {
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
  assert.ok(await fixture.isVisible(), 'This capture only uses the local fixture model')
  await editor.fill('请检查这个插件，并说明下一步应该补哪些测试。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  const next = page.locator('[data-composer-prediction="next"]')
  await next.locator('kbd').waitFor()
  await page.waitForFunction(() => document.querySelector('[data-composer-prediction="next"]')?.getAttribute('data-composer-prediction-state') === 'complete')
  await save(page, 'demo-next-message.png')
  await save(page.locator('[data-composer-card]').first(), 'demo-next-message-input.png')

  await editor.fill('请继续完善')
  const continuation = page.locator('[data-composer-prediction="continue"]')
  await continuation.locator('kbd').waitFor()
  await page.waitForFunction(() => document.querySelector('[data-composer-prediction="continue"]')?.getAttribute('data-composer-prediction-state') === 'complete')
  assert.ok((await continuation.innerText()).includes('并补上回归测试。'))
  await save(page, 'demo-continuation.png')
  await save(page.locator('[data-composer-card]').first(), 'demo-continuation-input.png')
  const draft = await editor.innerText()
  await editor.press('Tab')
  const accepted = await editor.innerText()
  assert.equal(accepted, '请继续完善并补上回归测试。')
  await save(page.locator('[data-composer-card]').first(), 'demo-accepted-input.png')
  assert.deepEqual(errors, [])
  await writeFile(new URL('demo-results.json', output), JSON.stringify({
    browser: await browser.version(), draft, accepted,
    screenshots: ['demo-next-message.png', 'demo-next-message-input.png', 'demo-continuation.png', 'demo-continuation-input.png', 'demo-accepted-input.png'],
    model: 'deterministic local fixture', pageErrors: errors,
  }, null, 2) + '\n')
  console.log('Captured next-message, inline continuation and Tab acceptance from the running Harness.')
} finally {
  await browser.close()
}
