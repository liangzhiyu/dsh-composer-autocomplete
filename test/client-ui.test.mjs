import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

function mount({ sessionId = 's1', draft = 'Can you also', active = false, stream = '', items = [' update the README'], caret = 100, width = 600, insert = true, running = false, fetch } = {}) {
  let definition, registered, request
  let index = 0, refIndex = 0, wrapper, tree
  const refs = []
  const state = [{ mode: draft === '' ? 'next' : 'continue', sessionId, draft, items, index: 0, stream, active }, { left: 100, top: 10, maxWidth: 400, height: 24 }, 0]
  const effects = [], layouts = [], listeners = new Map(), inserted = []
  const editor = { contains: node => node !== 'outside', getBoundingClientRect: () => ({ width, height: 100 }) }
  const card = { contains: () => true, querySelector: () => editor, getBoundingClientRect: () => ({ left: 0, top: 0, right: width, width, height: 100 }) }
  const document = { activeElement: editor, hidden: false, querySelector: () => card, createRange: () => ({ selectNodeContents() {}, setEnd() {}, toString: () => draft }), addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener() {} }
  const window = { __ModuleLoader__: { load: value => { definition = value } }, getSelection: () => ({ rangeCount: 1, getRangeAt: () => ({ collapsed: true, startContainer: {}, startOffset: draft.length, getBoundingClientRect: () => ({ left: caret, top: 10, width: 0, height: 24 }) }) }), getComputedStyle: () => ({ lineHeight: '24px' }), addEventListener() {}, removeEventListener() {} }
  const react = { Fragment: 'fragment', createElement: (type, props, ...children) => {
    const element = { type, props, children }
    // React assigns refs before effects; the harness does the same so the
    // overlay can locate the composer card that owns it.
    if (props && props.ref && typeof props.ref === 'object') props.ref.current = element
    if (props && props['data-composer-prediction-anchor'] !== undefined) {
      element.isConnected = true
      element.closest = selector => (selector === '[data-composer-card]' ? card : null)
    }
    return element
  }, useState: () => { const i = index++; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }] }, useRef: value => { const i = refIndex++; return refs[i] ?? (refs[i] = { current: value }) }, useCallback: fn => { request = fn; return fn }, useEffect: fn => effects.push(fn), useLayoutEffect: fn => layouts.push(fn), useSyncExternalStore: (_subscribe, read) => read() }
  vm.runInNewContext(source, { window, document, fetch, AbortController, TextDecoder, ReadableStream, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {} })
  const module = definition.factory(id => id === 'react' ? react : { Switch: 'switch' })
  module.apply({ locale: { bind: () => key => key, register() {} }, effect: fn => fn(), slots: { inject: (_name, fn) => fn(), register: (spec, component) => { if (spec.name === 'conversation.input.overlay') registered = component } } })
  const inputActions = { captureInsertion: () => ({}), insertText: value => { inserted.push(value); return insert }, setDraft: () => { throw new Error('Must never replace the draft') } }
  function rerender(update = {}) {
    sessionId = update.sessionId ?? sessionId
    draft = update.draft ?? draft
    running = update.running ?? running
    index = refIndex = 0
    effects.length = layouts.length = 0
    wrapper = registered({ sessionId, useInput: select => select({ draft }), useSessionStatus: select => select(new Map([[sessionId, { running }]])), inputActions })
    tree = wrapper.type(wrapper.props)
    return tree
  }
  rerender()
  return { state, effects, layouts, listeners, inserted, get request() { return request }, get tree() { return tree }, get wrapper() { return wrapper }, rerender, editor, document, helpers: module.__testing }
}

function keyEvent(key, extra = {}) {
  return { key, prevented: false, preventDefault() { this.prevented = true }, stopPropagation() {}, ...extra }
}

test('Tab leaves a streaming preview alone and accepts only final text', () => {
  const preview = mount({ active: true, items: [], stream: 'Can you also update the README' })
  for (const effect of preview.effects) effect()
  const early = keyEvent('Tab')
  preview.listeners.get('keydown')(early)
  assert.equal(early.prevented, false)
  assert.deepEqual(preview.inserted, [])
  const ready = mount()
  for (const effect of ready.effects) effect()
  const tab = keyEvent('Tab')
  ready.listeners.get('keydown')(tab)
  assert.equal(tab.prevented, true)
  assert.deepEqual(ready.inserted, [' update the README'])
})

test('refused insertion never replaces the existing draft', () => {
  const view = mount({ insert: false })
  for (const effect of view.effects) effect()
  assert.doesNotThrow(() => view.listeners.get('keydown')(keyEvent('Tab')))
  assert.equal(view.state[0].items.length, 0)
  assert.equal(view.state[1], null)
})

test('ending IME composition re-arms prediction timers even without another draft change', () => {
  const view = mount()
  for (const effect of view.effects) effect()
  view.listeners.get('compositionstart')({ target: view.editor })
  assert.equal(view.state[0].items.length, 0)
  view.listeners.get('compositionend')({ target: view.editor })
  assert.equal(view.state[2], 1)
})

test('right edge hides the ghost instead of moving it over the draft', () => {
  const edge = mount({ caret: 590 })
  for (const effect of edge.layouts) effect()
  assert.equal(edge.state[1], null)
  const fits = mount({ caret: 400 })
  for (const effect of fits.layouts) effect()
  assert.equal(fits.state[1].left, 400)
  assert.equal(fits.state[1].maxWidth, 184)
})

test('a stream ending without done clears the partial ghost', async () => {
  const view = mount({ fetch: async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"type":"delta","text":"partial text"}\n\n'))
    controller.close()
  } }), { headers: { 'content-type': 'text/event-stream' } }) })
  await view.request('continue', 'Can you also')
  assert.equal(view.state[0].active, false)
  assert.equal(view.state[0].stream, '')
  assert.equal(view.state[0].items.length, 0)
})

test('final suggestions have an accessible announcement, previews do not', () => {
  const ready = mount().tree
  assert.equal(ready.children[0].props.role, 'status')
  assert.equal(ready.children[0].props['aria-live'], 'polite')
  const preview = mount({ active: true, items: [], stream: 'preview text' }).tree
  assert.equal(preview.children[0].children[0], '')
})

test('the running agent neither requests nor displays draft continuations', async () => {
  let calls = 0
  const view = mount({ running: true, fetch: () => { calls++; throw new Error('must not call') } })
  await view.request('continue', '请你继续')
  assert.equal(calls, 0)
  assert.equal(view.tree.props['data-composer-prediction-anchor'], '')
})

test('composition in another editor does not dismiss this composer', () => {
  const view = mount()
  for (const effect of view.effects) effect()
  view.state[0] = { items: ['still visible'] }
  view.listeners.get('compositionstart')({ target: 'outside' })
  view.listeners.get('compositionend')({ target: 'outside' })
  assert.deepEqual(view.state[0].items, ['still visible'])
  assert.equal(view.state[2], 0)
})

test('an input event invalidates a suggestion before the next React render', () => {
  const view = mount()
  for (const effect of view.effects) effect()
  view.listeners.get('input')({ target: view.editor })
  view.listeners.get('keydown')(keyEvent('Tab'))
  assert.deepEqual(view.inserted, [])
})

test('IME owns Tab even when a browser omits isComposing on the key event', () => {
  const view = mount()
  for (const effect of view.effects) effect()
  view.listeners.get('compositionstart')({ target: view.editor })
  const event = keyEvent('Tab')
  view.listeners.get('keydown')(event)
  assert.equal(event.prevented, false)
  assert.deepEqual(view.inserted, [])
})

test('a late response for an old draft cannot replace the latest suggestion', async () => {
  let releaseOld, calls = 0
  const view = mount({ draft: 'old draft', fetch: async () => {
    calls++
    if (calls === 1) return new Promise(resolve => { releaseOld = resolve })
    return Response.json({ suggestions: ['new draft continuation'] })
  } })
  const old = view.request('continue', 'old draft')
  view.rerender({ draft: 'new draft' })
  await view.request('continue', 'new draft')
  releaseOld(Response.json({ suggestions: ['stale response'] }))
  await old
  assert.equal(view.state[0].items[0], 'new draft continuation')
})

test('a completed candidate is accepted while later candidates are still streaming', () => {
  const view = mount({ active: true, items: [' update the README'], stream: ' update the README\n another' })
  for (const effect of view.effects) effect()
  const tab = keyEvent('Tab')
  view.listeners.get('keydown')(tab)
  assert.equal(tab.prevented, true)
  assert.deepEqual(view.inserted, [' update the README'])
  assert.equal(view.tree.children[0].children[0], 'ready')
})

test('hiding the page cancels the in-flight model request and clears the ghost', async () => {
  let signal, release
  const view = mount({ fetch: (_url, options) => {
    signal = options.signal
    return new Promise(resolve => { release = resolve })
  } })
  for (const effect of view.effects) effect()
  const pending = view.request('continue', 'Can you also')
  view.document.hidden = true
  view.listeners.get('visibilitychange')()
  assert.equal(signal.aborted, true)
  assert.equal(view.state[0].items.length, 0)
  release(Response.json({ suggestions: ['obsolete'] }))
  await pending
  assert.equal(view.state[0].items.length, 0)
})

test('switching sessions hides the old ghost and rejects Tab before effect cleanup', () => {
  const view = mount({ sessionId: 'alpha' })
  for (const effect of view.effects) effect()
  view.state[0] = { mode: 'continue', sessionId: 'alpha', draft: 'Can you also',
    items: [' stale alpha text'], index: 0, stream: '', active: false }
  view.state[1] = { left: 100, top: 10, maxWidth: 400, height: 24 }
  const tree = view.rerender({ sessionId: 'beta' })
  assert.equal(tree.props['data-composer-prediction-anchor'], '')
  view.listeners.get('keydown')(keyEvent('Tab'))
  assert.deepEqual(view.inserted, [])
})

test('a response from the previous session is ignored even before abort cleanup runs', async () => {
  let release
  const view = mount({ sessionId: 'alpha', draft: '', fetch: () => new Promise(resolve => { release = resolve }) })
  const pending = view.request('next', '')
  view.rerender({ sessionId: 'beta' })
  release(Response.json({ suggestions: ['alpha text'] }))
  await pending
  assert.equal(view.state[0].items.length, 0)
})

test('rapid alpha-beta-alpha navigation cannot revive an earlier alpha request', async () => {
  let releaseOld, calls = 0
  const view = mount({ sessionId: 'alpha', draft: '', fetch: () => {
    if (++calls === 1) return new Promise(resolve => { releaseOld = resolve })
    return Response.json({ suggestions: ['latest alpha'] })
  } })
  const old = view.request('next', '')
  view.rerender({ sessionId: 'beta' })
  view.rerender({ sessionId: 'alpha' })
  await view.request('next', '')
  releaseOld(Response.json({ suggestions: ['obsolete alpha'] }))
  await old
  assert.equal(view.state[0].items[0], 'latest alpha')
  assert.equal(view.rerender().children[1].props.title, 'latest alpha')
})

test('a stale session timer cannot abort or overwrite the current session request', async () => {
  let calls = 0
  const view = mount({ sessionId: 'alpha', draft: '', fetch: () => {
    calls++
    return Response.json({ suggestions: ['beta text'] })
  } })
  const staleTimerRequest = view.request
  view.rerender({ sessionId: 'beta' })
  await view.request('next', '')
  await staleTimerRequest('next', '')
  assert.equal(calls, 1)
  assert.equal(view.state[0].items[0], 'beta text')
})

test('typing through a complete Chinese candidate reuses only its remaining text', () => {
  const { rebaseGhost } = mount().helpers
  const result = rebaseGhost({ sessionId: 's1', draft: '请继续', mode: 'continue',
    items: ['完善测试。'], index: 0 }, 's1', '请继续完善')
  assert.equal(result.items[0], '测试。')
  assert.equal(result.draft, '请继续完善')
  assert.equal(result.literal, true)
})

test('typing into an English word keeps its exact suffix without inserting a separator', () => {
  const { rebaseGhost } = mount().helpers
  const result = rebaseGhost({ sessionId: 's1', draft: 'Can you also', mode: 'continue',
    items: [' add regression tests'], index: 0 }, 's1', 'Can you also ad')
  assert.equal(result.items[0], 'd regression tests')
  assert.equal(result.literal, true)
})

test('next-message candidates can continue locally after their prefix is typed', () => {
  const { rebaseGhost } = mount().helpers
  const original = { sessionId: 's1', draft: '', mode: 'next', items: ['Please add tests', 'Please update docs'], index: 1 }
  const result = rebaseGhost(original, 's1', 'Please ')
  assert.equal(result.mode, 'continue')
  assert.equal(result.items[result.index], 'update docs')
  assert.equal(result.items.length, 2)
})

test('reuse rejects another session, changed prefixes, backspace and uncompleted previews', () => {
  const { rebaseGhost } = mount().helpers
  const original = { sessionId: 's1', draft: 'Please add', mode: 'continue', items: [' tests'], index: 0 }
  assert.equal(rebaseGhost(original, 's2', 'Please add t'), null)
  assert.equal(rebaseGhost(original, 's1', 'Please change'), null)
  assert.equal(rebaseGhost(original, 's1', 'Please ad'), null)
  assert.equal(rebaseGhost({ ...original, items: [], stream: 'partial' }, 's1', 'Please add t'), null)
})

test('typing the whole selected candidate consumes it without requesting another suggestion', () => {
  const { rebaseGhost } = mount().helpers
  const result = rebaseGhost({ sessionId: 's1', draft: '请继续', mode: 'continue',
    items: ['完善。'], index: 0 }, 's1', '请继续完善。')
  assert.equal(result.items.length, 0)
})
