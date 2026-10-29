# DeepSeek Harness Composer Autocomplete

**English** | [简体中文](README.zh-CN.md)

[![CI](https://github.com/liangzhiyu/dsh-composer-autocomplete/actions/workflows/ci.yml/badge.svg)](https://github.com/liangzhiyu/dsh-composer-autocomplete/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`dsh-composer-autocomplete` adds inline ghost-text completion and next-message suggestions to the native DeepSeek Harness Web composer. **Tab** accepts, **Esc** dismisses, and **Alt+↓ / Alt+↑** cycles candidates. Acceptance inserts an editable draft; it never sends a message.

Licensed under [MIT](LICENSE). By default, predictions use the model configured in your session and consume that service's tokens.

![Inline completion in the native composer](docs/images/composer-input.png)

The screenshot shows the actual Harness UI with a deterministic local test model.

## Install or update

Requirements: Node.js ≥ 24.9 and DeepSeek Harness. Tested with Harness `0.2.1-rc.2` Web. Install the prebuilt package from [GitHub Releases](https://github.com/liangzhiyu/dsh-composer-autocomplete/releases/latest):

```sh
dsh plugin --profile web add https://github.com/liangzhiyu/dsh-composer-autocomplete/releases/download/v0.2.3/dsh-composer-autocomplete-0.2.3.tgz
dsh web
```

Restart any running Harness instance after installation or updating. For the official desktop app, use its plugin installation UI to select the local package, or use the bundled `dsh` command to manage the desktop profile. The desktop shell has not been tested; this plugin uses the native composer slot on the Web client.

## Usage

- **Empty composer:** suggests your next message after an assistant turn finishes.
- **Draft completion:** requests a continuation after a typing pause, with the caret at the end. The default pause is 150 ms.
- **Fast mode (default):** one candidate, less context and a shorter output budget. Full mode keeps multiple candidates and the configured context limits.
- **Tab:** accepts the first complete candidate immediately, while later candidates may still be generating. Send the message yourself when ready.
- **Alt+↓ / Alt+↑:** cycles through up to three candidates in Full mode.
- **Esc:** dismisses the current suggestion. Editing the draft allows a new prediction.
- **Settings → General → Composer predictions:** controls the master switch, prediction modes, Fast/Full, and the typing pause (100–5000 ms).

Preferences are stored in the current browser on this device. IME composition keeps ownership of Tab. Predictions pause while the agent is running and stay out of native `/command` and `@reference` menus. Draft edits, session changes, disabling predictions, and hiding the page cancel pending requests. Text insertion goes through Harness's public input actions; a refused insertion never replaces the draft.

The native caret remains visible while suggestions are shown. After acceptance, it stays at the end of the inserted text; click or use the arrow keys to keep editing.

Switching sessions clears suggestions before paint and resets IME and dismissal state. Every candidate belongs to one session, draft, and request, so late responses cannot appear in or be accepted by another view. Result caches are isolated by session ID, session sequence, prediction mode, draft, and Fast/Full setting. Returning to a session can reuse its own valid cache; a new conversation turn invalidates the previous revision.

Typing the exact prefix of an already completed candidate reuses its remaining text locally, with no new model call. Unrelated edits invalidate it. IME composition pauses suggestions and keeps ownership of Tab.

Existing saved typing pauses are preserved. The 150 ms default applies only when no value has been saved. After upgrading, select 150 ms in settings if an older 300 ms preference remains.

## Latency

Measurements use the same deterministic local test model, timed from the end of typing. Each row is the median of six samples:

| Version / setting | First ghost text | Ready for Tab |
| --- | ---: | ---: |
| 0.2.2, 300 ms pause | 405 ms | 426 ms |
| 0.2.3 Fast, 150 ms pause | 256 ms | 277 ms |
| 0.2.3 Fast, 100 ms pause | 205 ms | 235 ms |

Matching an existing candidate measured 11 ms to update, with no network request (median of six typed characters).

These measure the local UI/SSE pipeline, not DeepSeek cloud speed or output quality. Actual latency depends on the network, model time to first token, formatting, and generation speed. See [method and raw data](docs/optimization.md). A shorter pause may increase request frequency; choose a longer pause in settings if preferred.

## Model usage and configuration

Predictions reuse the session's configured model route and host authentication; the plugin stores no separate API key. Recent conversation, tool activity, and the current draft are sent to that model and consume tokens. These auxiliary calls do not appear as conversation messages or in the session's displayed token usage. Configure an available model in Harness before using predictions.

Override host parameters in your profile's `cordis.patch.yml`:

For a slow thinking model, a separately configured fast prediction model can help: set both `provider` and `model` below. This leaves the main conversation model unchanged. Fast mode caps the configured limits at one candidate, 6 messages, 4000 context characters, 2 tool notes and 96 output tokens; Full mode uses the configured limits.

```yaml
- id: composer-autocomplete
  config:
    maxOutputTokens: 220
    timeoutMs: 20000
    maxMessages: 10
    maxChars: 8000
    maxSuggestions: 3
    maxToolNotes: 6
    cacheTtlMs: 60000
    maxCacheEntries: 200
    # Set both to use a dedicated prediction model; otherwise use the session route.
    # provider: your-provider
    # model: your-model
    # reasoningEffort: off
```

## Development and verification

The plugin uses native ESM and a Harness browser module. It has no build step or production npm dependencies.

```sh
node --test test/*.test.mjs
node tools/check-package.mjs
pnpm pack --pack-destination artifacts
```

Browser checks use Playwright against an isolated Harness Web instance with the plugin and local test-model adapter installed:

```sh
pnpm install --frozen-lockfile
DSH_URL=http://127.0.0.1:3087 node tools/browser-smoke.mjs
DSH_URL=http://127.0.0.1:3087 node tools/session-switch-smoke.mjs
DSH_URL=http://127.0.0.1:3087 node tools/caret-smoke.mjs
DSH_URL=http://127.0.0.1:3087 node tools/speed-smoke.mjs
```

The caret check captures the native caret without hiding it. With Pillow installed, verify its actual screenshot pixels with `python3 tools/verify-caret-pixels.py`.

See [verification scope and setup](docs/verification.md) and [changes](CHANGELOG.md).

## Uninstall

```sh
dsh plugin --profile web remove dsh-composer-autocomplete
```

Restart the relevant instance. Browser preferences remain; remove the `dsh-composer-autocomplete.*` local-storage keys in developer tools to reset them.
