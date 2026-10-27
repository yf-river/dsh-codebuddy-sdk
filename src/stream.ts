import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { CodeBuddyToolBridge } from './tool-bridge.js'
import { sameModel } from './models.js'

interface Delta { refusal?: string; content?: string; reasoning_content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }
interface Output { type: string; text?: string; refusal?: string; callId?: string; name?: string; arguments?: string; content?: { type: string; text?: string; refusal?: string }[]; summary?: { text?: string }[] }
export interface ModelEvent {
  type: string
  event?: { model?: string; choices?: { delta?: Delta; finish_reason?: string | null }[]; usage?: Record<string, unknown> }
  providerData?: { model?: string }
  delta?: string
  response?: { output?: Output[]; usage?: Record<string, unknown> }
}
interface Block { type: 'text' | 'reasoning' | 'tool-call'; text: string; id?: string; name?: string; index: number }

function usageOf(raw: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!raw) return undefined
  const input = raw.prompt_tokens ?? raw.inputTokens
  const output = raw.completion_tokens ?? raw.outputTokens
  if (typeof input !== 'number' || typeof output !== 'number') return undefined
  const details = (raw.prompt_tokens_details ?? raw.inputTokensDetails) as Record<string, unknown> | undefined
  const read = raw.cache_read_input_tokens ?? details?.cached_tokens
  const write = raw.cache_creation_input_tokens ?? details?.cache_write_tokens
  const counters: TokenUsage = { inputTokens: input - (typeof read === 'number' ? read : 0) - (typeof write === 'number' ? write : 0), outputTokens: output }
  if (typeof read === 'number') counters.cacheReadTokens = read
  if (typeof write === 'number') counters.cacheWriteTokens = write
  if (Object.values(counters).some(value => !Number.isFinite(value) || value < 0)) return undefined
  counters.totalTokens = input + output
  return counters
}

// 原始 provider 事件负责流式增量；response_done 的原生输出负责完整性校验。
export async function* translateStep(source: AsyncIterator<ModelEvent>, bridge: CodeBuddyToolBridge, expectedModel: string): AsyncGenerator<StreamChunk, { model: string }, void> {
  const blocks = new Map<string, Block>()
  let model: string | undefined, stop: string | null | undefined, rawUsage: Record<string, unknown> | undefined
  let sawProviderDeltas = false, refusal = ''
  function get(key: string, type: Block['type']): [Block, StreamChunk[]] {
    const found = blocks.get(key)
    if (found) return [found, []]
    const block: Block = { type, text: '', index: blocks.size }; blocks.set(key, block)
    return [block, [{ type: 'block-start', index: block.index, blockType: type }]]
  }
  function checkModel(value?: string): void {
    if (!value) return
    if (!sameModel(expectedModel, value)) throw new Error(`SDK 返回模型 ${value}，请求模型为 ${expectedModel}`)
    model = value
  }
  while (true) {
    const next = await source.next()
    if (next.done) throw new Error('模型流在完整输出之前关闭')
    const event = next.value
    checkModel(event.event?.model ?? event.providerData?.model)
    if (event.type === 'model' && event.event?.choices) {
      sawProviderDeltas = true
      if (event.event.usage) rawUsage = event.event.usage
      const choice = event.event.choices[0]
      stop = choice?.finish_reason ?? stop
      const delta = choice?.delta
      if (delta?.refusal) refusal += delta.refusal
      for (const [key, type, value] of [['reasoning', 'reasoning', delta?.reasoning_content], ['text', 'text', delta?.content]] as const) {
        if (!value) continue
        const [block, start] = get(key, type); yield* start; block.text += value
        yield type === 'text' ? { type: 'text-delta', index: block.index, text: value } : { type: 'reasoning-delta', index: block.index, text: value }
      }
      for (const call of delta?.tool_calls ?? []) {
        const [block, start] = get(`tool:${call.index}`, 'tool-call'); yield* start
        if (call.id) block.id = call.id
        if (call.function?.name) block.name = call.function.name
        if (call.function?.arguments) {
          block.text += call.function.arguments
          if (block.id && block.name) yield { type: 'tool-call-delta', index: block.index, id: ToolCallId(block.id), name: bridge.harnessName(block.name), argumentsDelta: call.function.arguments }
        }
      }
    } else if (!sawProviderDeltas && event.type === 'output_text_delta' && event.delta) {
      const [block, start] = get('text', 'text'); yield* start; block.text += event.delta
      yield { type: 'text-delta', index: block.index, text: event.delta }
    } else if (event.type === 'response_done') {
      const output = event.response?.output
      if (!output || !model) throw new Error('完整模型输出缺少原生内容或模型标识')
      let toolIndex = 0
      for (const item of output) {
        const finalRefusal = item.type === 'refusal' ? item.refusal ?? item.text : item.content?.filter(part => part.type === 'refusal').map(part => part.refusal ?? part.text ?? '').join('')
        if (finalRefusal) refusal = finalRefusal
      }
      for (const item of output) {
        if (item.type === 'function_call') {
          const [block, start] = get(`tool:${toolIndex++}`, 'tool-call'); yield* start
          if (block.id && block.id !== item.callId) throw new Error('流式工具 ID 与完整输出不一致')
          if (block.name && block.name !== item.name) throw new Error('流式工具名称与完整输出不一致')
          if (block.text && block.text !== item.arguments) throw new Error('流式工具参数与完整输出不一致')
          block.id = item.callId; block.name = item.name; block.text = item.arguments ?? block.text
        } else if (item.type === 'message' || item.type === 'reasoning') {
          const type = item.type === 'message' ? 'text' : 'reasoning'
          const value = (item.type === 'message' ? item.content : item.content ?? item.summary)?.filter(part => part.type !== 'refusal').map(part => part.text ?? '').join('') ?? ''
          if (!value) continue
          const [block, start] = get(type, type); yield* start
          if (block.text && block.text !== value) throw new Error('流式内容与完整输出不一致')
          block.text = value
        }
      }
      const truncated = stop === 'length' || stop === 'max_tokens'
      if (stop && !['stop', 'tool_calls', 'function_call', 'length', 'max_tokens', 'content_filter'].includes(stop)) throw new LlmError(`未知模型结束原因：${stop}`, 'INVALID_RESPONSE')
      const calls = [...blocks.values()].filter(block => block.type === 'tool-call')
      if (calls.length && (truncated || refusal || stop === 'content_filter')) throw new LlmError('模型未完整完成工具调用，未交给 DSH 执行', 'INCOMPLETE_TOOL_CALL')
      if (calls.length !== toolIndex) throw new Error('流式工具数量与完整输出不一致')
      // 在交付任何可执行工具前完成整批校验，避免同一响应的后半部分失败。
      const completed: { index: number; block: ContentBlock }[] = []
      for (const block of blocks.values()) {
        let content: ContentBlock
        if (block.type === 'tool-call') {
          if (!block.id || !block.name) throw new Error('工具调用缺少 ID 或名称')
          let args: unknown
          try { args = JSON.parse(block.text) } catch { throw new LlmError('工具参数不是完整 JSON，未交给 DSH 执行', 'INVALID_TOOL_CALL') }
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new LlmError('工具参数必须是 JSON 对象', 'INVALID_TOOL_CALL')
          bridge.noteToolCall(block.id, block.name, args)
          content = { type: 'tool-call', id: ToolCallId(block.id), name: bridge.harnessName(block.name), arguments: block.text }
        } else content = { type: block.type, text: block.text }
        completed.push({ index: block.index, block: content })
      }
      for (const block of completed) yield { type: 'block-end', ...block }
      if (refusal) {
        const index = blocks.size
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'text-delta', index, text: refusal }
        yield { type: 'block-end', index, block: { type: 'text', text: refusal } }
      }
      // 未收到 provider 计数时，SDK 的零值可能是占位计数，不能当作真实零消耗。
      const fallback = event.response?.usage
      const usage = usageOf(rawUsage ?? (fallback && (Number(fallback.inputTokens) > 0 || Number(fallback.outputTokens) > 0) ? fallback : undefined))
      if (usage) yield { type: 'usage', usage }
      if (refusal || stop === 'content_filter') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'REFUSAL', message: refusal || '模型拒绝了本次请求（content_filter）' } } }
      } else {
        if (!truncated && !calls.length && !completed.some(item => item.block.type === 'text' && item.block.text.trim())) throw new LlmError('模型正常结束但未返回可用回复', 'EMPTY_RESPONSE')
        yield { type: 'finish', reason: calls.length ? { kind: 'tool-calls' } : truncated ? { kind: 'max-tokens' } : { kind: 'stop' } }
      }
      return { model }
    }
  }
}
