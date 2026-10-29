/** Deterministic local model used only by the isolated integration profile. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { setTimeout as pause } from 'node:timers/promises'

export const inject = ['llm']

class FixtureAdapter extends LlmAdapter {
  providerInfo(provider) { return { id: provider, name: '本地验证模型' } }
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Autocomplete fixture' }] }
  async resolveModel(provider, model) {
    return { provider, id: model, name: 'Autocomplete fixture', context: { contextWindow: 1000000 }, defaultMaxTokens: 1024 }
  }
  async *stream(options) {
    const system = typeof options.system === 'string' ? options.system : ''
    const next = system.includes('follow-up suggestion engine')
    const continuation = system.includes('You complete the message')
    const prompt = JSON.stringify(options.messages)
    const scope = prompt.includes('SESSION_ALPHA') ? 'ALPHA' : prompt.includes('SESSION_BETA') ? 'BETA' : null
    let text = scope && (next || continuation)
      ? next ? `${prompt.includes('SESSION_ALPHA_UPDATED') ? '复核' : '检查'} ${scope} 会话的测试\n补充 ${scope} 的文档\n继续 ${scope} 的任务`
        : `并检查 ${scope} 的实现。\n再完善 ${scope} 的测试。`
      : next ? '请补充测试用例\n检查一下边界情况\n把安装步骤写到 README'
      : continuation ? prompt.includes('Can you also')
        ? ' add regression tests\n update the README\n check edge cases'
        : '并补上回归测试。\n然后验证安装步骤。\n并检查输入法兼容。'
      : scope ? `${scope} 会话：本地验证回复已完成。`
        : '本地验证回复：已检查输入框自动补全，可以继续补充测试。'
    if ((next || continuation) && system.includes('Return up to 1 ')) text = text.split('\n')[0] + '\n'
    await pause(next || continuation ? prompt.includes('RACE_DELAY') ? 1500 : 80 : 400, undefined, { signal: options.signal })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    let heldTail = false
    for (let i = 0; i < text.length; i += 5) {
      options.signal?.throwIfAborted()
      yield { type: 'text-delta', index: 0, text: text.slice(i, i + 5) }
      if (!heldTail && continuation && prompt.includes('SLOW_TAIL') && text.slice(i, i + 5).includes('\n')) {
        heldTail = true
        await pause(800, undefined, { signal: options.signal })
      }
      await pause(25, undefined, { signal: options.signal })
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 16, outputTokens: text.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['autocomplete-fixture'], new FixtureAdapter()))
}
