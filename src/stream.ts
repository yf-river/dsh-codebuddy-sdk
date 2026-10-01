/**
 * CodeBuddy message-stream translation into the Harness streaming protocol.
 *
 * CodeBuddy reports Anthropic-shaped `content_block_*` events plus a final
 * `assistant`/`result` message. The Harness vocabulary keeps tool arguments as
 * raw JSON strings and ends a step at the first tool call so its own loop can
 * execute the tool, so this translator stops at that boundary.
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {
  AssistantMessage,
  Message as CodeBuddyMessage,
  ResultMessage,
} from '@tencent-ai/agent-sdk'

type ToolCallId = Branded<'CallId'>
type StopReason = AssistantMessage['message']['stop_reason']
type Usage = AssistantMessage['message']['usage']

function toolCallId(value: string): ToolCallId {
  return value as ToolCallId
}

export interface StreamTranslation {
  chunks: StreamChunk[]
  /** True when this step ended on a tool call and the loop must execute it. */
  awaitingTool: boolean
  sessionId?: string
  failure?: { message: string; code?: string }
}

function mapUsage(usage: Usage | undefined): TokenUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    ...(usage?.cache_read_input_tokens ?? 0) > 0 ? { cacheReadTokens: usage.cache_read_input_tokens } : {},
    ...(usage?.cache_creation_input_tokens ?? 0) > 0 ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {},
  }
}

function mapStopReason(reason: StopReason | null | undefined): FinishReason {
  switch (reason) {
    case 'tool_use':
      return { kind: 'tool-calls' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'refusal':
      return {
        kind: 'error',
        failure: { message: 'CodeBuddy refused the request', code: 'REFUSAL' },
      }
    default:
      return { kind: 'stop' }
  }
}

function isResult(message: CodeBuddyMessage): message is ResultMessage {
  return message.type === 'result'
}

function isAssistant(message: CodeBuddyMessage): message is AssistantMessage {
  return message.type === 'assistant'
}

/**
 * Consume one CodeBuddy turn.
 *
 * The returned chunks always end with `finish`; a tool-use turn ends with
 * `{ kind: 'tool-calls' }` without a `usage` chunk when the CLI supplied none,
 * and the caller is responsible for invoking `endQuery()` afterwards.
 */
export async function* toStreamChunks(
  source: AsyncIterable<CodeBuddyMessage>,
  callerSignal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  let sawToolCall = false
  let emittedTerminal = false
  const toolIndex = new Map<number, { id: string; name: string }>()

  for await (const message of source) {
    if (message.type === 'stream_event') {
      const event = message.event
      switch (event.type) {
        case 'content_block_start': {
          if (event.content_block.type === 'text') {
            yield { type: 'block-start', index: event.index, blockType: 'text' }
          } else if (event.content_block.type === 'thinking') {
            yield { type: 'block-start', index: event.index, blockType: 'reasoning' }
          } else if (event.content_block.type === 'tool_use') {
            toolIndex.set(event.index, { id: event.content_block.id, name: event.content_block.name })
            yield { type: 'block-start', index: event.index, blockType: 'tool-call' }
          }
          break
        }
        case 'content_block_delta': {
          const delta = event.delta
          if (delta.type === 'text_delta') {
            yield { type: 'text-delta', index: event.index, text: delta.text }
          } else if (delta.type === 'thinking_delta') {
            yield { type: 'reasoning-delta', index: event.index, text: delta.thinking }
          } else if (delta.type === 'input_json_delta') {
            const known = toolIndex.get(event.index)
            yield {
              type: 'tool-call-delta',
              index: event.index,
              id: toolCallId(known?.id ?? ''),
              ...known?.name === undefined ? {} : { name: known.name },
              argumentsDelta: delta.partial_json,
            }
          }
          break
        }
        case 'content_block_stop': {
          // The assembled `assistant` message carries the authoritative
          // arguments; emitting a block-end here would win the Harness's
          // first-close-wins race and drop them.
          if (toolIndex.has(event.index)) sawToolCall = true
          break
        }
        default:
          break
      }
      continue
    }

    if (isAssistant(message)) {
      if (message.error) {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: message.error, code: 'CODEBUDDY_ERROR' } },
        }
        emittedTerminal = true
        return
      }
      for (const [index, block] of message.message.content.entries()) {
        if (block.type === 'text') {
          yield { type: 'block-end', index, block: { type: 'text', text: block.text } }
        } else if (block.type === 'thinking') {
          yield { type: 'block-end', index, block: { type: 'reasoning', text: block.thinking } }
        } else if (block.type === 'tool_use') {
          sawToolCall = true
          yield {
            type: 'block-end',
            index,
            block: {
              type: 'tool-call',
              id: toolCallId(block.id),
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          }
        }
      }
      if (!sawToolCall && message.message.stop_reason === 'tool_use') sawToolCall = true
      continue
    }

    if (isResult(message)) {
      yield { type: 'usage', usage: mapUsage(message.usage) }
      if (message.is_error || message.subtype !== 'success') {
        const detail = message.subtype === 'success'
          ? 'CodeBuddy reported an error'
          : message.errors?.join('; ') ?? message.subtype
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: detail, code: 'CODEBUDDY_ERROR' } },
        }
      } else {
        yield { type: 'finish', reason: mapStopReason(sawToolCall ? 'tool_use' : 'end_turn') }
      }
      emittedTerminal = true
      return
    }
  }

  if (!emittedTerminal) {
    yield {
      type: 'finish',
      reason: callerSignal?.aborted
        ? { kind: 'aborted', failure: { message: 'CodeBuddy query aborted', code: 'ABORTED' } }
        : sawToolCall
          ? { kind: 'tool-calls' }
          : { kind: 'error', failure: { message: 'CodeBuddy query ended without a result', code: 'STREAM_CLOSED' } },
    }
  }
}
