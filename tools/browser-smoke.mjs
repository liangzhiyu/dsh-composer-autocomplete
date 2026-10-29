import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const output = new URL('artifacts/', root)
await mkdir(output, { recursive: true })
let startUrl = process.env.DSH_URL || 'http://127.0.0.1:3087/'
try {
  const log = await readFile(new URL('.verification/harness.log', root), 'utf8')
  const local = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/u)?.[0]
  if (local && new URL(local).origin === new URL(startUrl).origin) startUrl = local
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(startUrl).hostname), 'Use an isolated loopback test profile')

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.addInitScript(() => {
  if (localStorage.getItem('dsh-composer-autocomplete.options') === null) {
    localStorage.setItem('dsh-composer-autocomplete.options', JSON.stringify({ next: true, continuation: true, debounceMs: 300, profile: 'balanced' }))
  }
})
const page = await context.newPage()
page.setDefaultTimeout(15000)
const errors = [], results = [], requests = []
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => {
  if (new URL(request.url()).pathname === '/composer-autocomplete/v2') requests.push(JSON.parse(request.postData()))
})
const check = (name) => { results.push(name); console.log('PASS ' + name) }
const screenshot = name => page.screenshot({ path: fileURLToPath(new URL(name, output)) })
const ready = async mode => {
  const ghost = page.locator(`[data-composer-prediction="${mode}"]`)
  await ghost.waitFor()
  await ghost.locator('kbd').waitFor()
  return ghost
}
const noGhost = async () => page.locator('[data-composer-prediction]').waitFor({ state: 'hidden' })

try {
  await page.goto(startUrl)
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
  assert.ok(await fixture.isVisible(), 'Only the deterministic fixture may receive these test messages')
  await editor.fill('请检查输入框自动补全')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  let ghost = await ready('next')
  await page.waitForFunction(() => document.querySelector('[data-composer-prediction="next"]')?.textContent.includes('1/3'))
  assert.ok((await ghost.innerText()).includes('请补充测试用例'))
  await screenshot('01-next-message.png')
  check('真实 Harness 回复后经宿主模型与 SSE 显示下一句灰字')

  await editor.click()
  await editor.press('Alt+ArrowDown')
  await page.waitForFunction(() => document.querySelector('[data-composer-prediction]')?.textContent.includes('检查一下边界情况'))
  await editor.press('Alt+ArrowUp')
  await editor.press('Tab')
  assert.equal(await editor.innerText(), '请补充测试用例')
  await noGhost()
  assert.ok(await page.getByRole('button', { name: /^1 轮 1 步/u }).isVisible())
  check('Alt+方向键切换候选；Tab 只插入草稿，不发送')

  await editor.fill('请继续完善')
  ghost = await ready('continue')
  assert.ok((await ghost.innerText()).includes('并补上回归测试。'))
  await screenshot('02-chinese-continuation.png')
  await editor.press('Tab')
  assert.equal(await editor.innerText(), '请继续完善并补上回归测试。')
  check('中文续写在真实光标后显示，采纳保留原稿且不添加多余空格')

  await editor.fill('请协助整理')
  await ready('continue')
  await editor.press('Escape')
  await noGhost()
  await page.waitForTimeout(900)
  assert.equal(await page.locator('[data-composer-prediction]').count(), 0)
  assert.equal(await editor.innerText(), '请协助整理')
  check('Esc 关闭当前建议并保留草稿')

  await editor.fill('输入法测试')
  await editor.dispatchEvent('compositionstart', { data: 'pin' })
  // The resident editor adds a composition sentinel; Tab must preserve that DOM too.
  const composingDraft = await editor.innerText()
  const beforeIme = requests.length
  await page.waitForTimeout(900)
  assert.equal(requests.length, beforeIme)
  await editor.press('Tab')
  assert.equal(await editor.innerText(), composingDraft)
  await editor.dispatchEvent('compositionend', { data: '拼音' })
  await editor.click()
  await editor.press('ArrowRight')
  await ready('continue')
  await page.getByRole('button', { name: '账号菜单', exact: true }).dispatchEvent('compositionstart', { data: 'x' })
  assert.equal(await page.locator('[data-composer-prediction]').count(), 1)
  check('中文 IME 组合时不请求、不抢 Tab；组合结束恢复，其他控件组合不干扰')

  await editor.fill('Can you also')
  ghost = await ready('continue')
  assert.ok((await ghost.innerText()).includes('add regression tests'))
  await screenshot('03-english-continuation.png')
  await editor.press('Tab')
  assert.equal(await editor.innerText(), 'Can you also add regression tests')
  check('英文续写正确保留一个分隔空格')

  await editor.fill('请继续完善 SLOW_TAIL')
  ghost = await ready('continue')
  assert.equal(await ghost.getAttribute('data-composer-prediction-state'), 'streaming')
  await editor.press('Tab')
  assert.equal(await editor.innerText(), '请继续完善 SLOW_TAIL并补上回归测试。')
  assert.ok(await page.getByRole('button', { name: /^1 轮 1 步/u }).isVisible())
  check('其余候选仍在生成时即可 Tab 采纳首条完整候选，并取消剩余请求')

  for (const prefix of ['/he', '@README']) {
    await editor.fill(prefix)
    await page.waitForTimeout(900)
    assert.equal(await page.locator('[data-composer-prediction]').count(), 0)
    assert.equal(await editor.innerText(), prefix)
  }
  await editor.press('Escape')
  check('原生 /命令和 @引用输入时不出现 AI 续写')

  await page.getByRole('button', { name: '账号菜单', exact: true }).click()
  await page.getByText('设置', { exact: true }).click()
  await page.getByText('通用设置', { exact: true }).click()
  const master = page.getByRole('switch', { name: '输入预测', exact: true })
  await master.waitFor()
  const nextSwitch = page.getByRole('switch', { name: '回复结束后预测下一句', exact: true })
  await nextSwitch.click()
  await page.getByRole('combobox', { name: '输入停顿时间（毫秒）' }).selectOption('1000')
  await page.getByRole('combobox', { name: '补全模式', exact: true }).selectOption('fast')
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-composer-autocomplete.options')).profile), 'fast')
  await page.getByRole('combobox', { name: '补全模式', exact: true }).selectOption('balanced')
  await screenshot('04-settings.png')
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-composer-autocomplete.options'))), {
    next: false, continuation: true, debounceMs: 1000, profile: 'balanced',
  })
  await page.getByText('深色', { exact: true }).click()
  await page.getByRole('button', { name: '关闭', exact: true }).last().click()
  await editor.fill('请继续检查')
  await ready('continue')
  await screenshot('05-dark-continuation.png')
  await page.setViewportSize({ width: 780, height: 900 })
  await ready('continue')
  await page.waitForFunction(() => {
    const ghost = document.querySelector('[data-composer-prediction]')?.getBoundingClientRect()
    const editor = document.querySelector('[contenteditable="true"]')?.getBoundingClientRect()
    return ghost && editor && ghost.right <= editor.right + 1 && ghost.left >= editor.left
  })
  await screenshot('06-narrow-dark.png')
  check('深色和窄窗口中灰字仍位于编辑器范围内')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByRole('button', { name: '账号菜单', exact: true }).click()
  await page.getByText('设置', { exact: true }).click()
  await page.getByText('通用设置', { exact: true }).click()
  await master.click()
  await page.getByRole('button', { name: '关闭', exact: true }).last().click()
  await editor.fill('关闭后的输入')
  const beforeDisabled = requests.length
  await page.waitForTimeout(1300)
  assert.equal(requests.length, beforeDisabled)
  await noGhost()
  check('真实设置页可以分别控制预测模式、延迟和总开关')

  await page.reload()
  await page.locator('[contenteditable="true"]').first().waitFor()
  assert.equal(await page.evaluate(() => localStorage.getItem('dsh-composer-autocomplete.enabled')), 'false')
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-composer-autocomplete.options')).debounceMs), 1000)
  check('刷新页面后设置仍然保留')
  assert.deepEqual(errors, [])
  check('完整操作无浏览器脚本异常')

  await writeFile(new URL('browser-results.json', output), JSON.stringify({
    harness: '0.2.1-rc.2', model: 'deterministic local fixture', browser: await browser.version(),
    checks: results, predictionRequests: requests.length, pageErrors: errors,
  }, null, 2) + '\n')
} catch (error) {
  await screenshot('browser-failure.png').catch(() => {})
  await writeFile(new URL('browser-failure.txt', output), await page.locator('body').innerText()).catch(() => {})
  throw error
} finally {
  await browser.close()
}
