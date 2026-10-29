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
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(startUrl).hostname), 'Use an isolated local profile')

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
page.setDefaultTimeout(15000)
const editor = page.locator('[contenteditable="true"]').first()
const errors = [], checks = [], screenshots = []
page.on('pageerror', error => errors.push(error.message))
const check = name => { checks.push(name); console.log('PASS ' + name) }
async function selection() {
  return editor.evaluate(node => {
    const selection = window.getSelection()
    if (!selection?.rangeCount) return null
    const range = selection.getRangeAt(0)
    if (!range.collapsed || !node.contains(range.startContainer)) return null
    const prefix = document.createRange()
    prefix.selectNodeContents(node)
    prefix.setEnd(range.startContainer, range.startOffset)
    const box = node.closest('[data-composer-card]').getBoundingClientRect()
    let rect = range.getBoundingClientRect()
    const style = getComputedStyle(node)
    if (!rect.height) {
      const bounds = node.getBoundingClientRect()
      rect = { left: bounds.left + parseFloat(style.paddingLeft),
        top: bounds.top + parseFloat(style.paddingTop), height: parseFloat(style.lineHeight) }
    }
    return { focused: document.activeElement === node, prefix: prefix.toString(), text: node.innerText,
      caretColor: style.caretColor, x: rect.left - box.left, y: rect.top - box.top, height: rect.height,
      scale: window.devicePixelRatio }
  })
}
async function capture(name) {
  const state = await selection()
  assert.ok(state?.focused, 'Native selection remains focused inside the editor')
  assert.notEqual(state.caretColor, 'rgba(0, 0, 0, 0)')
  // Freeze the native blink for screenshots only; keep its native color/geometry.
  await editor.evaluate(node => {
    if (CSS.supports('caret-animation', 'manual')) node.style.setProperty('caret-animation', 'manual')
  })
  await page.locator('[data-composer-card]').first().screenshot({
    path: fileURLToPath(new URL(name, output)), caret: 'initial',
  })
  screenshots.push({ file: name, ...state })
  return state
}

try {
  await page.goto(startUrl)
  await editor.waitFor()
  await page.waitForLoadState('networkidle')
  const intro = page.getByRole('button', { name: '继续', exact: true })
  if (await intro.isVisible()) await intro.click()
  const fixture = page.getByRole('button', { name: /选择模型，当前 Autocomplete fixture/u })
  if (!await fixture.isVisible()) {
    await page.getByRole('button', { name: '请选择模型', exact: true }).click()
    await page.getByText('Autocomplete fixture', { exact: true }).last().click()
  }
  assert.ok(await fixture.isVisible(), 'Only the local fixture receives test messages')
  await editor.fill('请检查输入框光标')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await page.locator('[data-composer-prediction="next"] kbd').waitFor()
  await editor.click()
  assert.equal((await capture('caret-next.png')).prefix, '')
  check('The empty composer keeps its native caret while next-message ghost text is visible')

  await editor.fill('请继续完善')
  await page.locator('[data-composer-prediction="continue"] kbd').waitFor()
  await editor.hover()
  const preview = await capture('caret-continuation.png')
  assert.equal(preview.prefix, '请继续完善')
  assert.equal(preview.text, '请继续完善')
  check('Continuation preview keeps the native caret and does not modify the draft or selection')

  await editor.press('Tab')
  const accepted = '请继续完善并补上回归测试。'
  const after = await capture('caret-after-tab.png')
  assert.equal(after.text, accepted)
  assert.equal(after.prefix, accepted)
  await editor.press('ArrowLeft')
  assert.equal((await selection()).prefix, accepted.slice(0, -1))
  await editor.press('!')
  const edited = accepted.slice(0, -1) + '!' + accepted.slice(-1)
  assert.equal(await editor.innerText(), edited)
  check('Tab leaves the caret after the insertion; arrow keys and typing continue editing in place')

  const point = await editor.evaluate(node => {
    const text = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode()
    const range = document.createRange()
    range.setStart(text, 1)
    range.setEnd(text, 2)
    const rect = range.getBoundingClientRect()
    return { x: rect.right - 0.1, y: rect.top + rect.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  assert.equal((await selection()).prefix, edited.slice(0, 2))
  await editor.press('X')
  assert.equal(await editor.innerText(), edited.slice(0, 2) + 'X' + edited.slice(2))
  await capture('caret-after-click.png')
  assert.ok(await page.getByRole('button', { name: /^1 轮 1 步/u }).isVisible())
  assert.deepEqual(errors, [])
  check('Mouse clicks reposition the native caret after completion; typing edits there without sending')

  await writeFile(new URL('caret-results.json', output), JSON.stringify({
    harness: '0.2.1-rc.2', model: 'deterministic local fixture', browser: await browser.version(),
    checks, screenshots, pageErrors: errors,
  }, null, 2) + '\n')
} catch (error) {
  await page.screenshot({ path: fileURLToPath(new URL('caret-failure.png', output)), caret: 'initial' }).catch(() => {})
  throw error
} finally { await browser.close() }
