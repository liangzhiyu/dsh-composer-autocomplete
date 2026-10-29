/**
 * Browser half of composer predictions.
 *
 * Two modes share one overlay:
 * - `next`: after a turn settles and the composer is empty, the Host streams
 *   candidate follow-up messages as ghost text over the placeholder.
 * - `continue`: while the user pauses mid-draft with the caret at the end, the
 *   Host streams continuations of that draft and the ghost follows the caret.
 *
 * Tab accepts the current candidate as an editable draft, Alt+Down / Alt+Up
 * cycle between candidates, Escape dismisses one. Typing aborts in-flight work
 * and hides the ghost; nothing is ever sent to the agent by accepting.
 *
 * The overlay seat is anchored to the composer card, so the ghost measures the
 * resident editor and follows its padding, line height, and scroll position.
 */

window.__ModuleLoader__.load({
  id: 'dsh-composer-autocomplete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * Local switch button. The host's own switch is a harness Client package,
     * which a bundle must not load: it can change without notice, and a throw
     * would take the whole plugin down. This reproduces its markup, CSS and
     * behaviour with plugin-owned classes and theme tokens only.
     */
    const SWITCH_CSS = [
      '.cp-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}',
      '.cp-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
      '.cp-switch:disabled{cursor:default;opacity:.5}',
      '.cp-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.cp-switch__thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s}',
      '.cp-switch[aria-checked="false"] .cp-switch__thumb{background:var(--dsw-alias-switch-thumb)}',
      '.cp-switch[aria-checked="true"] .cp-switch__thumb{transform:translate(16px)}',
    ].join('')

    function Switch({ checked, label, onChange, disabled }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked === true ? 'true' : 'false',
          'aria-label': label,
          className: 'cp-switch',
          disabled: disabled === true,
          onClick: () => onChange(checked !== true),
        },
        h('span', { className: 'cp-switch__thumb', 'aria-hidden': 'true' }),
      )
    }

    const NS = 'composer-autocomplete'
    const ENDPOINT = '/composer-autocomplete/v2'
    const SLOT = 'conversation.input.overlay'

    /** Wait for the settled UI before asking, so a fresh turn is fully committed. */
    const SETTLE_MS = 600
    const FAST_SETTLE_MS = 200
    /** A continuation needs enough text to continue from. */
    const CONTINUE_MIN_CHARS = 3
    /** The Host bounds the draft too; this keeps the request body small. */
    const MAX_DRAFT_CHARS = 4_000
    /** Ignore the first characters of a streaming answer to avoid flicker. */
    const STREAM_MIN_CHARS = 3

    /** Editor text insets from the resident composer styles. */
    const EDITOR_INSET_TOP = 4
    const EDITOR_INSET_LEFT = 14
    const EDITOR_INSET_RIGHT = 8
    /** The editable scroll container's right margin, outside the text column. */
    const EDITOR_SCROLL_MARGIN = 4
    const FALLBACK_LINE_HEIGHT = 24

    const DICTIONARIES = {
      en: {
        label: 'Composer prediction',
        accept: 'Press Tab to accept this suggestion',
        more: 'Alt+Down for the next suggestion',
        enabled: 'Composer predictions',
        description: 'Suggest your next message and continue drafts. Uses your model and tokens. Saved in this browser on this device.',
        ready: 'Suggestion: {text}. Press Tab to accept. Alt+Down or Alt+Up changes candidates. Escape dismisses.',
        next: 'Suggest the next message',
        continuation: 'Continue while typing',
        delay: 'Typing pause (milliseconds)',
        profile: 'Completion mode',
        fast: 'Fast — one candidate',
        balanced: 'Full — multiple candidates',
      },
      zh: {
        label: '输入预测',
        accept: '按 Tab 采纳该建议',
        more: '按 Alt+↓ 查看下一条建议',
        enabled: '输入预测',
        description: '建议下一条消息并续写草稿。会调用模型并消耗 token。设置保存在当前设备的浏览器中。',
        ready: '建议：{text}。按 Tab 采纳，Alt+↓ 或 Alt+↑ 切换，Escape 关闭。',
        next: '回复结束后预测下一句',
        continuation: '输入停顿时续写',
        delay: '输入停顿时间（毫秒）',
        profile: '补全模式',
        fast: '快速：一条候选',
        balanced: '完整：多条候选',
      },
    }

    const PREFERENCE_KEY = 'dsh-composer-autocomplete.enabled'
    const OPTIONS_KEY = 'dsh-composer-autocomplete.options'
    const DEFAULT_PREFERENCES = Object.freeze({ next: true, continuation: true, debounceMs: 150, profile: 'fast' })

    function normalizePreferences(value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      return Object.freeze({
        next: typeof source.next === 'boolean' ? source.next : DEFAULT_PREFERENCES.next,
        continuation: typeof source.continuation === 'boolean' ? source.continuation : DEFAULT_PREFERENCES.continuation,
        debounceMs: Number.isInteger(source.debounceMs) && source.debounceMs >= 100 && source.debounceMs <= 5000
          ? source.debounceMs : DEFAULT_PREFERENCES.debounceMs,
        profile: source.profile === 'balanced' ? 'balanced' : 'fast',
      })
    }

    function storedPreferences(raw) {
      try {
        return normalizePreferences(JSON.parse(raw))
      } catch {
        // A corrupt preference must not prevent the composer from mounting.
        return DEFAULT_PREFERENCES
      }
    }

    let enabled = true
    let preferences = DEFAULT_PREFERENCES
    try {
      enabled = window.localStorage.getItem(PREFERENCE_KEY) !== 'false'
      preferences = storedPreferences(window.localStorage.getItem(OPTIONS_KEY))
    } catch {
      // Restricted storage keeps the preference in memory for this window.
    }
    const preferenceListeners = new Set()
    const subscribePreference = (listener) => {
      preferenceListeners.add(listener)
      return () => preferenceListeners.delete(listener)
    }
    const readEnabled = () => enabled
    const readPreferences = () => preferences
    function setPreferences(update) {
      preferences = normalizePreferences({ ...preferences, ...update })
      try {
        window.localStorage.setItem(OPTIONS_KEY, JSON.stringify(preferences))
      } catch {
        // Restricted storage still permits changing the current window.
      }
      for (const listener of preferenceListeners) listener()
    }
    function setEnabled(value) {
      enabled = value
      try {
        window.localStorage.setItem(PREFERENCE_KEY, String(value))
      } catch {
        // The switch still works for this window when storage is unavailable.
      }
      for (const listener of preferenceListeners) listener()
    }
    function useEnabled() {
      return React.useSyncExternalStore(subscribePreference, readEnabled, readEnabled)
    }
    function PredictionsSetting({ t }) {
      const checked = useEnabled()
      const options = React.useSyncExternalStore(subscribePreference, readPreferences, readPreferences)
      const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, padding: '12px 0' }
      return h('div', { style: { padding: '4px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' } },
        h('style', null, SWITCH_CSS),
        h('div', { style: rowStyle },
        h('div', null,
          h('div', { style: { fontSize: 14, lineHeight: '20px' } }, t('enabled')),
          h('div', { style: { fontSize: 12, lineHeight: '18px', marginTop: 4, color: 'var(--dsw-alias-label-secondary)' } }, t('description')),
        ),
        h(Switch, { checked, label: t('enabled'), onChange: setEnabled }),
        ),
        ...['next', 'continuation'].map(key => h('div', { key, style: rowStyle },
          h('span', null, t(key)),
          h(Switch, { checked: options[key], label: t(key), disabled: !checked,
            onChange: value => setPreferences({ [key]: value }) }),
        )),
        h('label', { style: rowStyle },
          h('span', null, t('profile')),
          h('select', {
            'aria-label': t('profile'), value: options.profile, disabled: !checked,
            onChange: event => setPreferences({ profile: event.target.value }),
            style: { font: 'inherit', color: 'inherit', background: 'var(--dsw-specific-input-major)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: '4px 8px' },
          }, ...['fast', 'balanced'].map(profile => h('option', { key: profile, value: profile }, t(profile)))),
        ),
        h('label', { style: rowStyle },
          h('span', null, t('delay')),
          h('select', {
            'aria-label': t('delay'), value: options.debounceMs, disabled: !checked || !options.continuation,
            onChange: event => setPreferences({ debounceMs: Number(event.target.value) }),
            style: { font: 'inherit', color: 'inherit', background: 'var(--dsw-specific-input-major)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: '4px 8px' },
          }, ...[100, 150, 200, 300, 400, 600, 1000, 1500, 2500, 5000].map(ms => h('option', { key: ms, value: ms }, String(ms)))),
        ),
      )
    }

    const NO_GHOST = { mode: 'next', items: [], index: 0, stream: '', active: false }

    const NEXT_GHOST_STYLE = {
      position: 'absolute',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      boxSizing: 'border-box',
      fontFamily: 'inherit',
      fontSize: 'inherit',
      lineHeight: 'inherit',
      color: 'var(--dsw-alias-label-caption)',
      background: 'var(--dsw-specific-input-major)',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      userSelect: 'none',
      zIndex: 2,
    }

    /** The continuation ghost hugs its text and sits where the caret is. */
    const CONTINUE_GHOST_STYLE = {
      ...NEXT_GHOST_STYLE,
      gap: '6px',
      padding: '0 4px',
      borderRadius: '4px',
      zIndex: 3,
    }

    const TEXT_STYLE = {
      flex: '1 1 auto',
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      opacity: 0.9,
    }

    const CONTINUE_TEXT_STYLE = {
      ...TEXT_STYLE,
      flex: '0 1 auto',
    }

    const KEYCAP_STYLE = {
      flex: 'none',
      fontSize: '11px',
      lineHeight: '16px',
      padding: '0 5px',
      borderRadius: '4px',
      border: '1px solid var(--dsw-alias-border-l2)',
      color: 'var(--dsw-alias-label-tertiary)',
      background: 'transparent',
    }

    const BADGE_STYLE = {
      flex: 'none',
      fontSize: '10px',
      lineHeight: '14px',
      color: 'var(--dsw-alias-label-tertiary)',
      opacity: 0.8,
    }

    // Paint the native editor (and its caret) above the opaque ghost background.
    // The editor is transparent; the placeholder stays underneath the ghost.
    const CARET_CSS = '[data-composer-card]:has([data-composer-prediction]) [contenteditable="true"]{position:relative;z-index:4;cursor:text}'

    /**
     * Locate the composer card this overlay actually belongs to.
     *
     * The seat is rendered inside the resident composer card, so the anchor node
     * is an ancestor-scoped key: a global `querySelector` would pick whichever
     * card happens to be first in the document and paint that conversation's
     * ghost over another one.
     */
    function composerElementsNear(anchor) {
      if (typeof document === 'undefined') return null
      if (anchor === null || anchor === undefined || !anchor.isConnected) return null
      const card = anchor.closest('[data-composer-card]')
      if (card === null) return null
      const editor = card.querySelector('[contenteditable="true"]') || card.querySelector('[role="textbox"]')
      return editor === null ? null : { card, editor }
    }

    /** The collapsed selection inside the editor, when it is there at all. */
    function readCaret(editor) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return null
      const selection = window.getSelection()
      if (selection === null || selection.rangeCount === 0) return null
      const range = selection.getRangeAt(0)
      if (range === null || !range.collapsed) return null
      if (!editor.contains(range.startContainer)) return null

      const prefixRange = document.createRange()
      prefixRange.selectNodeContents(editor)
      prefixRange.setEnd(range.startContainer, range.startOffset)
      const prefix = prefixRange.toString()

      const rect = caretRect(range)
      if (rect === null) return null
      return { prefix, left: rect.left, top: rect.top, height: rect.height }
    }

    function caretRect(range) {
      let rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        const rects = range.getClientRects()
        if (rects.length > 0) rect = rects[0]
      }
      if ((rect.width === 0 && rect.height === 0) || rect.top === 0 && rect.left === 0) {
        const fallback = rectBeforeCaret(range)
        if (fallback !== null) return fallback
      }
      if (rect.width === 0 && rect.height === 0) return null
      return { left: rect.left, top: rect.top, height: rect.height }
    }

    /** Measure the character before the caret when the collapsed range is empty. */
    function rectBeforeCaret(range) {
      const node = range.startContainer
      const offset = range.startOffset
      if (typeof Node === 'undefined' || node === null || node.nodeType !== Node.TEXT_NODE || offset <= 0) return null
      const probe = document.createRange()
      probe.setStart(node, offset - 1)
      probe.setEnd(node, offset)
      const rect = probe.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return null
      return { left: rect.right, top: rect.top, height: rect.height }
    }

    /** Whether the caret is at the effective end of the draft. */
    function caretAtEnd(editor, draft) {
      const caret = readCaret(editor)
      if (caret === null) return null
      const draftText = collapse(draft.trimEnd())
      const prefix = collapse(caret.prefix.trimEnd())
      if (prefix === '') return null
      // Strict equality: a prefix that also happens to be a suffix must not
      // pass, or the ghost targets (and later inserts at) a mid-draft caret.
      return draftText === prefix ? caret : null
    }

    function collapse(text) {
      return text.replace(/\s+/gu, ' ').trim()
    }

    /** A half-typed `/command` or `@reference` is not a message continuation. */
    function isTriggerToken(draft) {
      return /(?:^|\s)\/[^\s]*$/u.test(draft) || /(?:^|\s)@"?[^\s]*$/u.test(draft)
    }

    /** Show the model's first line while it is still streaming. */
    function streamingCandidate(stream) {
      if (stream.trim().length < STREAM_MIN_CHARS) return ''
      for (const raw of stream.split(/\r?\n/u)) {
        let line = raw.trim()
        if (line === '') continue
        if (/^none$/iu.test(line)) return ''
        line = cleanLine(line)
        if (line === '') continue
        return line.length > 240 ? line.slice(0, 240) : line
      }
      return ''
    }

    function cleanLine(line) {
      return line
        .replace(/^(?:[-*•]|\d+[.)])\s+/u, '')
        .replace(/^["'`\u201c\u201d]+|["'`\u201c\u201d]+$/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
    }

    /**
     * Join a continuation onto the draft without gluing words together.
     * Avoid repeating a separator already present in the exact draft.
     */
    function joinContinuation(draft, value) {
      if (draft === '' || value === '') return value
      if (/\s$/u.test(draft)) return value.replace(/^\s+/u, '')
      if (/^\s/u.test(value)) return value
      const last = draft.slice(-1)
      const first = value.slice(0, 1)
      // CJK text does not use a word separator; never invent one there.
      if (isCjk(last) || isCjk(first)) return value
      if (/[([{/\-—"'`]$/u.test(last)) return value
      if (/^[,.;:!?)\]}%]/u.test(first)) return value
      return ` ${value}`
    }

    function isCjk(character) {
      return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(character)
    }

    /** Reuse only complete candidates when the user types their exact prefix. */
    function rebaseGhost(previous, sessionId, draft) {
      if (previous?.sessionId !== sessionId || typeof previous.draft !== 'string' ||
        !Array.isArray(previous.items) || previous.items.length === 0 ||
        !draft.startsWith(previous.draft) || draft.length <= previous.draft.length) return null
      const typed = draft.slice(previous.draft.length)
      const matches = previous.items.map((item, index) => {
        const value = previous.mode === 'continue' && !previous.literal
          ? joinContinuation(previous.draft, item) : item
        return value.startsWith(typed) ? { index, value: value.slice(typed.length) } : null
      }).filter(Boolean)
      if (matches.length === 0) return null
      const selected = matches.find(item => item.index === previous.index)
      const items = selected?.value.trim() === '' ? [] : matches.filter(item => item.value.trim() !== '').map(item => item.value)
      return { mode: 'continue', sessionId, draft, items,
        index: Math.max(0, items.indexOf(selected?.value)), literal: true, stream: '', active: false, request: null }
    }

    function sameBox(left, right) {
      return (
        left !== null &&
        left !== undefined &&
        left.top === right.top &&
        left.left === right.left &&
        left.height === right.height &&
        left.right === right.right &&
        left.maxWidth === right.maxWidth
      )
    }

    /** Parse a fully buffered SSE body, for shells that cannot stream fetch bodies. */
    function parseSseText(text) {
      const events = []
      for (const frame of text.replace(/\r\n/gu, '\n').split('\n\n')) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '') continue
          try {
            events.push(JSON.parse(payload))
          } catch {
            // Ignore a malformed frame.
          }
        }
      }
      return events
    }

    /** Read one SSE body and hand every `data:` payload to the callback. */
    async function consumeStream(body, signal, onEvent) {
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let terminal = false
      const onAbort = () => { void reader.cancel().catch(() => {}) }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        if (signal.aborted) onAbort()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (signal.aborted) break
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/gu, '\n')
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue
              const payload = line.slice(5).trim()
              if (payload === '') continue
              try {
                const event = JSON.parse(payload)
                if (event.type === 'done' || event.type === 'error') terminal = true
                onEvent(event)
              } catch {
                // A malformed frame is ignored; the draft keeps working.
              }
            }
            boundary = buffer.indexOf('\n\n')
          }
        }
        return terminal
      } finally {
        signal.removeEventListener('abort', onAbort)
        reader.releaseLock()
      }
    }

    function ComposerPrediction(props) {
      const { sessionId, useInput, useSessionStatus, inputActions, t } = props
      const predictionsEnabled = useEnabled()
      const preferences = React.useSyncExternalStore(subscribePreference, readPreferences, readPreferences)
      const draft = useInput((state) => (state === undefined ? '' : state.draft || ''))
      const running = useSessionStatus((state) => (state === undefined ? false : state.get(sessionId)?.running === true))
      const [ghost, setGhost] = React.useState(NO_GHOST)
      const [box, setBox] = React.useState(null)
      const [compositionEnd, setCompositionEnd] = React.useState(0)

      const anchorRef = React.useRef(null)
      const elements = () => composerElementsNear(anchorRef.current)
      const abortRef = React.useRef(null)
      const composingRef = React.useRef(false)
      const dismissedRef = React.useRef(null)
      const acceptRef = React.useRef(null)
      const cycleRef = React.useRef(null)
      const currentRef = React.useRef('')
      const scopeRef = React.useRef(null)
      scopeRef.current = { sessionId, draft }
      const ghostRef = React.useRef(ghost)
      ghostRef.current = ghost
      const typedGhostRef = React.useRef(null)
      const reusedDraftRef = React.useRef(null)

      const request = React.useCallback(
        async (mode, draftText) => {
          if (sessionId === undefined || sessionId === null) return
          if (!predictionsEnabled || running || composingRef.current) return
          if (mode === 'next' ? !preferences.next : !preferences.continuation) return
          if (typeof document !== 'undefined' && document.hidden) return
          const scope = scopeRef.current
          // A timer from the previous view may fire before its effect cleans up.
          if (scope.sessionId !== sessionId || (mode === 'next'
            ? scope.draft !== ''
            : scope.draft.slice(-MAX_DRAFT_CHARS) !== draftText)) return
          abortRef.current?.abort()
          const controller = new AbortController()
          abortRef.current = controller
          const isCurrent = () => !controller.signal.aborted && abortRef.current === controller &&
            scopeRef.current.sessionId === scope.sessionId && scopeRef.current.draft === scope.draft
          setGhost({ mode, sessionId, draft: scope.draft, request: controller,
            items: [], index: 0, stream: '', active: true })

          const settle = (items) => {
            if (!isCurrent()) return
            items = items.slice(0, preferences.profile === 'fast' ? 1 : 5)
            setGhost((previous) => {
              if (!isCurrent() || previous.request !== controller) return previous
              if (items.length === 0) return NO_GHOST
              return { ...previous, items, index: Math.min(previous.index, items.length - 1), stream: '', active: false }
            })
          }

          try {
            const response = await fetch(ENDPOINT, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
              body: JSON.stringify({ sessionId, mode, draft: draftText, profile: preferences.profile }),
              signal: controller.signal,
            })
            if (!response.ok || controller.signal.aborted) {
              settle([])
              return
            }

            const contentType = response.headers.get('content-type') || ''
            if (!contentType.includes('text/event-stream')) {
              // Compatibility path: an older Host answers one JSON prediction.
              const payload = await response.json().catch(() => null)
              const items = Array.isArray(payload?.suggestions)
                ? payload.suggestions.filter((item) => typeof item === 'string' && item !== '')
                : typeof payload?.suggestion === 'string' && payload.suggestion !== ''
                  ? [payload.suggestion]
                  : []
              settle(items)
              return
            }

            if (response.body === null) {
              // Some desktop shells buffer the fetch body; parse the whole stream.
              const text = await response.text().catch(() => '')
              const done = parseSseText(text).find((event) => event.type === 'done')
              settle(
                Array.isArray(done?.items)
                  ? done.items.filter((item) => typeof item === 'string' && item !== '')
                  : [],
              )
              return
            }

            const terminal = await consumeStream(response.body, controller.signal, (event) => {
              if (!isCurrent()) return
              if (event.type === 'delta' && typeof event.text === 'string') {
                setGhost((previous) =>
                  isCurrent() && previous.request === controller && previous.active
                    ? { ...previous, stream: previous.stream + event.text }
                    : previous,
                )
              } else if (event.type === 'candidates' && Array.isArray(event.items)) {
                const items = event.items.filter(item => typeof item === 'string' && item !== '').slice(0, preferences.profile === 'fast' ? 1 : 5)
                if (items.length > 0) setGhost(previous => isCurrent() && previous.request === controller
                  ? { ...previous, items, index: Math.min(previous.index, items.length - 1) }
                  : previous)
              } else if (event.type === 'done') {
                const items = Array.isArray(event.items)
                  ? event.items.filter((item) => typeof item === 'string' && item !== '')
                  : []
                settle(items)
              } else if (event.type === 'error') {
                settle([])
              }
            })
            if (!terminal) settle([])
          } catch {
            // An aborted or failed prediction is silent: the composer keeps working.
            if (!controller.signal.aborted) settle([])
          }
        },
        [sessionId, predictionsEnabled, running, preferences],
      )

      React.useEffect(() => {
        if (predictionsEnabled) return
        abortRef.current?.abort()
        typedGhostRef.current = reusedDraftRef.current = null
        setGhost(NO_GHOST)
        setBox(null)
      }, [predictionsEnabled])

      React.useEffect(() => {
        abortRef.current?.abort()
        typedGhostRef.current = reusedDraftRef.current = null
        setGhost(NO_GHOST)
        setBox(null)
      }, [preferences])

      // IME composition owns the draft until it commits: no prediction work.
      React.useEffect(() => {
        const isOwnEditor = event => {
          const found = elements()
          return found !== null && event.target !== null && found.editor.contains(event.target)
        }
        const onCompositionStart = event => {
          if (!isOwnEditor(event)) return
          composingRef.current = true
          abortRef.current?.abort()
          typedGhostRef.current = reusedDraftRef.current = null
          setGhost(NO_GHOST)
          setBox(null)
        }
        const onCompositionEnd = event => {
          if (!isOwnEditor(event)) return
          composingRef.current = false
          setCompositionEnd(value => value + 1)
        }
        const onInput = event => {
          if (!isOwnEditor(event)) return
          typedGhostRef.current = composingRef.current ? null : ghostRef.current
          // Clear immediately, before React publishes the next draft snapshot.
          abortRef.current?.abort()
          currentRef.current = ''
          setGhost(NO_GHOST)
          setBox(null)
        }
        document.addEventListener('compositionstart', onCompositionStart, true)
        document.addEventListener('compositionend', onCompositionEnd, true)
        document.addEventListener('input', onInput, true)
        return () => {
          document.removeEventListener('compositionstart', onCompositionStart, true)
          document.removeEventListener('compositionend', onCompositionEnd, true)
          document.removeEventListener('input', onInput, true)
        }
      }, [])

      // A different Session starts from a clean slate.
      React.useLayoutEffect(() => {
        dismissedRef.current = null
        abortRef.current?.abort()
        composingRef.current = false
        currentRef.current = ''
        typedGhostRef.current = reusedDraftRef.current = null
        setGhost(NO_GHOST)
        setBox(null)
        return () => abortRef.current?.abort()
      }, [sessionId])

      // Reuse an exact typed prefix before paint; unrelated edits still invalidate.
      React.useLayoutEffect(() => {
        abortRef.current?.abort()
        const found = elements()
        const reusable = predictionsEnabled && preferences.continuation && !running && !composingRef.current &&
          !isTriggerToken(draft) && found !== null && caretAtEnd(found.editor, draft) !== null
          ? rebaseGhost(typedGhostRef.current ?? ghost, sessionId, draft) : null
        typedGhostRef.current = null
        reusedDraftRef.current = reusable === null ? null : { sessionId, draft }
        setGhost(reusable?.items.length ? reusable : NO_GHOST)
        if (dismissedRef.current !== null && dismissedRef.current.draft !== draft) {
          dismissedRef.current = null
        }
        if (reusable !== null && reusable.items.length === 0) dismissedRef.current = { draft }
      }, [draft])

      // A starting turn drops the ghost and re-arms a dismissed prediction.
      React.useEffect(() => {
        if (!running) return
        abortRef.current?.abort()
        typedGhostRef.current = reusedDraftRef.current = null
        setGhost(NO_GHOST)
        dismissedRef.current = null
      }, [running])

      // `next`: ask once the turn has settled and the composer is empty.
      React.useEffect(() => {
        if (sessionId === undefined || sessionId === null) return undefined
        if (!predictionsEnabled || !preferences.next || running || draft !== '') return undefined
        if (dismissedRef.current !== null && dismissedRef.current.draft === draft) return undefined
        const timer = setTimeout(() => {
          if (composingRef.current) return
          void request('next', '')
        }, preferences.profile === 'fast' ? FAST_SETTLE_MS : SETTLE_MS)
        return () => clearTimeout(timer)
      }, [sessionId, running, draft, request, predictionsEnabled, preferences, compositionEnd])

      // `continue`: ask after a pause, only with the caret at the draft's end.
      React.useEffect(() => {
        if (sessionId === undefined || sessionId === null) return undefined
        if (!predictionsEnabled || !preferences.continuation || running || draft.trim() === '' || draft.length < CONTINUE_MIN_CHARS) return undefined
        if (reusedDraftRef.current?.sessionId === sessionId && reusedDraftRef.current.draft === draft) return undefined
        if (isTriggerToken(draft)) return undefined
        if (dismissedRef.current !== null && dismissedRef.current.draft === draft) return undefined
        const timer = setTimeout(() => {
          if (composingRef.current) return
          const found = elements()
          if (found === null) return
          if (caretAtEnd(found.editor, draft) === null) return
          void request('continue', draft.slice(-MAX_DRAFT_CHARS))
        }, preferences.debounceMs)
        return () => clearTimeout(timer)
      }, [sessionId, running, draft, request, predictionsEnabled, preferences, compositionEnd])

      // A prediction skipped while the page was hidden is retried on return.
      React.useEffect(() => {
        const onVisibility = () => {
          if (document.hidden) {
            abortRef.current?.abort()
            typedGhostRef.current = reusedDraftRef.current = null
            currentRef.current = ''
            setGhost(NO_GHOST)
            setBox(null)
            return
          }
          if (!predictionsEnabled || running) return
          if (draft !== '') {
            setCompositionEnd(value => value + 1)
            return
          }
          if (currentRef.current !== '' || dismissedRef.current !== null) return
          if (sessionId === undefined || sessionId === null) return
          void request('next', '')
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, [draft, running, sessionId, request, predictionsEnabled])

      // Never render or accept an old view's ghost, even before effect cleanup.
      const ownsGhost = ghost.sessionId === sessionId && ghost.draft === draft
      const rawCandidate = !ownsGhost ? '' : ghost.items.length > 0
        ? ghost.items[Math.min(ghost.index, ghost.items.length - 1)] ?? ''
        : streamingCandidate(ghost.stream)
      const current = ghost.mode === 'continue' && !ghost.literal ? joinContinuation(draft, rawCandidate) : rawCandidate
      currentRef.current = current
      const hasCandidate = current !== ''

      const visible =
        predictionsEnabled && !running && !composingRef.current &&
        (ghost.mode === 'next' ? preferences.next : preferences.continuation) &&
        current !== '' &&
        box !== null &&
        (ghost.mode === 'next'
          ? draft === '' && !running
          : draft.trim() !== '' && !isTriggerToken(draft))

      // `next` ghost spans the editor's text column.
      React.useLayoutEffect(() => {
        if (ghost.mode !== 'next') return undefined
        const measure = () => {
          const found = elements()
          if (found === null) {
            setBox((previous) => (previous === null ? previous : null))
            return
          }
          const cardRect = found.card.getBoundingClientRect()
          const editorRect = found.editor.getBoundingClientRect()
          if (editorRect.width <= 0 || editorRect.height <= 0) {
            setBox((previous) => (previous === null ? previous : null))
            return
          }
          const computed = window.getComputedStyle(found.editor)
          const lineHeight = Number.parseFloat(computed.lineHeight)
          const paddingTop = Number.parseFloat(computed.paddingTop)
          const paddingLeft = Number.parseFloat(computed.paddingLeft)
          const topInset = Number.isFinite(paddingTop) ? paddingTop : EDITOR_INSET_TOP
          const leftInset = Number.isFinite(paddingLeft) ? paddingLeft : EDITOR_INSET_LEFT
          const next = {
            top: Math.max(0, Math.round(editorRect.top - cardRect.top + topInset)),
            left: Math.max(0, Math.round(editorRect.left - cardRect.left + leftInset)),
            right: Math.max(EDITOR_INSET_RIGHT, Math.round(cardRect.right - editorRect.right + EDITOR_SCROLL_MARGIN)),
            height: Number.isFinite(lineHeight) && lineHeight > 0 ? Math.round(lineHeight) : FALLBACK_LINE_HEIGHT,
          }
          setBox((previous) => (sameBox(previous, next) ? previous : next))
        }
        measure()
        const found = elements()
        let observer
        if (found !== null && typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(measure)
          observer.observe(found.card)
          observer.observe(found.editor)
        }
        window.addEventListener('resize', measure)
        return () => {
          observer?.disconnect()
          window.removeEventListener('resize', measure)
        }
      }, [ghost.mode, draft, sessionId, running, hasCandidate])

      // `continue` ghost follows the caret.
      React.useLayoutEffect(() => {
        if (ghost.mode !== 'continue') return undefined
        let frame = 0
        const measure = () => {
          frame = 0
          const found = elements()
          if (found === null) {
            setBox((previous) => (previous === null ? previous : null))
            return
          }
          const caret = caretAtEnd(found.editor, draft)
          if (caret === null) {
            setBox((previous) => (previous === null ? previous : null))
            return
          }
          const editorRect = found.editor.getBoundingClientRect()
          if (editorRect.width <= 0 || editorRect.height <= 0) {
            setBox((previous) => (previous === null ? previous : null))
            return
          }
          const cardRect = found.card.getBoundingClientRect()
          const computed = window.getComputedStyle(found.editor)
          const lineHeight = Number.parseFloat(computed.lineHeight)
          const height =
            Number.isFinite(caret.height) && caret.height > 0
              ? Math.round(caret.height)
              : Number.isFinite(lineHeight) && lineHeight > 0
                ? Math.round(lineHeight)
                : FALLBACK_LINE_HEIGHT
          const desired = caret.left - cardRect.left
          const left = Math.max(0, desired)
          const maxWidth = cardRect.right - (cardRect.left + left) - 16
          if (maxWidth < 48) {
            setBox((previous) => (previous === null ? previous : null))
            return
          }
          const top = caret.top - cardRect.top
          // A caret scrolled above or below the card has no honest place to draw.
          if (top < 0 || top > cardRect.height - 8) {
            setBox((previous) => (previous === null ? previous : null))
            return
          }
          const next = {
            top: Math.round(top),
            left: Math.round(left),
            maxWidth: Math.round(maxWidth),
            height,
          }
          setBox((previous) => (sameBox(previous, next) ? previous : next))
        }
        const schedule = () => {
          if (frame === 0) frame = requestAnimationFrame(measure)
        }
        measure()
        document.addEventListener('selectionchange', schedule)
        document.addEventListener('scroll', schedule, true)
        const found = elements()
        window.addEventListener('resize', schedule)
        let observer
        if (found !== null && typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(schedule)
          observer.observe(found.card)
          observer.observe(found.editor)
        }
        return () => {
          if (frame !== 0) cancelAnimationFrame(frame)
          document.removeEventListener('selectionchange', schedule)
          document.removeEventListener('scroll', schedule, true)
          window.removeEventListener('resize', schedule)
          observer?.disconnect()
        }
      }, [ghost.mode, draft, sessionId, running, hasCandidate])

      const accept = () => {
        const value = currentRef.current
        if (!ownsGhost || value === '' || ghost.items.length === 0) return
        const expected = ghost.mode === 'continue' ? draft + value : value
        dismissedRef.current = { draft: expected }
        abortRef.current?.abort()
        setGhost(NO_GHOST)
        setBox(null)
        try {
          // A refused insertion must never be bypassed by replacing the draft.
          if (inputActions.insertText(value, inputActions.captureInsertion()) !== true) return
        } catch {
          return
        }
        // Accepting leaves an editable draft: hand the keyboard back to the editor.
        try {
          const found = elements()
          if (found !== null && !found.card.contains(document.activeElement)) found.editor.focus()
        } catch {
          // Focus is a courtesy, never a failure.
        }
      }
      acceptRef.current = accept

      const cycle = (delta) => {
        setGhost((previous) => {
          if (previous.items.length <= 1) return previous
          const index = (previous.index + delta + previous.items.length) % previous.items.length
          return { ...previous, index }
        })
      }
      cycleRef.current = cycle

      React.useEffect(() => {
        if (!visible) return undefined
        const onKeyDown = (event) => {
          if (event.defaultPrevented) return
          // An IME candidate window owns the keyboard while composing.
          if (composingRef.current || event.isComposing === true || event.keyCode === 229) return
          const found = elements()
          if (found === null) return
          const target = typeof Node !== 'undefined' && event.target instanceof Node ? event.target : null
          const inEditor = found.editor.contains(document.activeElement)
          const inCard =
            found.card.contains(document.activeElement) || (target !== null && found.card.contains(target))
          if (!inCard) return
          if (event.key === 'Escape') {
            // Dismiss only this suggestion: keep the gesture away from the
            // composer's own Escape handling (the Esc-Esc stop sequence).
            event.preventDefault()
            event.stopPropagation()
            dismissedRef.current = { draft }
            abortRef.current?.abort()
            setGhost(NO_GHOST)
            setBox(null)
            return
          }
          if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            if (ghost.items.length <= 1) return
            event.preventDefault()
            event.stopPropagation()
            cycleRef.current?.(event.key === 'ArrowDown' ? 1 : -1)
            return
          }
          if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return
          // Tab belongs to the editor only; on composer controls it must keep
          // its normal focus-traversal behavior.
          if (!inEditor || ghost.items.length === 0) return
          if (ghost.mode === 'next' && typeof found.editor.textContent === 'string' && found.editor.textContent !== '') return
          if (ghost.mode === 'continue' && caretAtEnd(found.editor, draft) === null) return
          event.preventDefault()
          event.stopPropagation()
          acceptRef.current?.()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [visible, draft, ghost.items.length, ghost.active, ghost.mode])

      const anchor = h('span', {
        ref: anchorRef,
        'data-composer-prediction-anchor': '',
        'data-composer-prediction-session': sessionId,
        'aria-hidden': 'true',
        style: { display: 'none' },
      })

      if (!visible || box === null) return anchor

      const continuation = ghost.mode === 'continue'
      const style = continuation ? CONTINUE_GHOST_STYLE : NEXT_GHOST_STYLE
      const showKeycap = ghost.items.length > 0 && (!continuation || (box.maxWidth ?? 0) >= 96)
      const showBadge = ghost.items.length > 1

      return h(React.Fragment, null,
        h('span', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', style: { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' } }, ghost.items.length === 0 ? '' : t('ready').replace('{text}', current)),
        h('div',
          {
            style: { ...style, ...box },
            'aria-hidden': 'true',
            'data-composer-prediction': ghost.mode,
            'data-composer-prediction-session': sessionId,
            'data-composer-prediction-state': ghost.active ? 'streaming' : 'complete',
            title: current,
          },
          h('span', { style: continuation ? CONTINUE_TEXT_STYLE : TEXT_STYLE }, current),
          showBadge ? h('span', { style: BADGE_STYLE, title: t('more') }, `${ghost.index + 1}/${ghost.items.length}`) : null,
          showKeycap ? h('kbd', { style: KEYCAP_STYLE, title: t('accept') }, 'Tab') : null,
        ),
        anchor,
        h('style', null, CARET_CSS),
      )
    }

    return {
      inject: ['slots', 'locale'],
      __testing: { joinContinuation, rebaseGhost, parseSseText, streamingCandidate, cleanLine, consumeStream, setEnabled, readEnabled, normalizePreferences, setPreferences, readPreferences },
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES))
        ctx.effect(() => {
          const onStorage = (event) => {
            if (event.key !== PREFERENCE_KEY && event.key !== OPTIONS_KEY && event.key !== null) return
            if (event.key === PREFERENCE_KEY || event.key === null) enabled = event.newValue !== 'false'
            if (event.key === OPTIONS_KEY || event.key === null) preferences = storedPreferences(event.newValue)
            for (const listener of preferenceListeners) listener()
          }
          window.addEventListener('storage', onStorage)
          return () => window.removeEventListener('storage', onStorage)
        })
        ctx.slots.inject('settings.general.item', () => ctx.slots.register(
          { name: 'settings.general.item', id: 'composer-autocomplete', order: 50, label: () => t('enabled') },
          () => h(PredictionsSetting, { t }),
        ))
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: 'composer-autocomplete',
              order: 10,
              label: () => t('label'),
            },
            (slotProps) => h(ComposerPrediction, { ...slotProps, key: slotProps.sessionId, t }),
          ),
        )
      },
    }
  },
})
