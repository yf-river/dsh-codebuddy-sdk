/**
 * CodeBuddy message-stream translation into the Harness streaming protocol.
 *
 * CodeBuddy reports Anthropic-shaped `content_block_*` events plus a final
 * `assistant`/`result` message. The Harness vocabulary keeps tool arguments as
 * raw JSON strings and ends a step at the first tool call so its own loop can
 * execute the tool, so one call to {@link translateStep} consumes exactly one
 * CodeBuddy turn and stops at that boundary.
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, Message as CodeBuddyMessage } from '@tencent-ai/agent-sdk'
import type { CodeBuddyToolBridge } from './tool-bridge.js'

type ToolCallId = Branded<'CallId'>
type StopReason = AssistantMessage['message']['stop_reason']
type Usage = AssistantMessage['message']['usage']

function toolCallId(value: string): ToolCallId {
  return value as ToolCallId
}

export interface StepStatus {
  /** True when this step ended on a tool call and the loop must run it. */
  awaitingTool: boolean
  /** True when the conversation reached a terminal result and can be released. */
  ended: boolean
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
      return { kind: 'error', failure: { message: 'CodeBuddy refused the request', code: 'REFUSAL' } }
    default:
      return { kind: 'stop' }
  }
}

/**
 * Consume one CodeBuddy turn and yield Harness chunks.
 *
 * A turn that calls a tool ends the iteration after yielding its `finish`
 * chunk: the next step's `translateStep()` call resumes the same query, at
 * which point the still-pending MCP handlers receive their results.
 *
 * The iterator is advanced with an explicit `next()` rather than `for await`:
 * a `for await` that returns early would call `iterator.return()`, which tears
 * down the CLI the next step still needs.
 */
export async function* translateStep(
  source: AsyncIterator<CodeBuddyMessage>,
  bridge: CodeBuddyToolBridge,
  callerSignal?: AbortSignal,
): AsyncGenerator<StreamChunk, StepStatus, void> {
  let sawToolCall = false
  const toolIndex = new Map<number, { id: string; name: string }>()
  const argumentBuffers = new Map<number, string>()

  while (true) {
    const next = await source.next()
    if (next.done) break
    const message = next.value
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
            argumentBuffers.set(event.index, '')
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
            argumentBuffers.set(event.index, (argumentBuffers.get(event.index) ?? '') + delta.partial_json)
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
          // The assembled assistant message below is authoritative and is the
          // only place a `block-end` is emitted, so the Harness's
          // first-close-wins rule cannot drop the real arguments.
          if (toolIndex.has(event.index)) sawToolCall = true
          break
        }
        default:
          break
      }
      continue
    }

    if (message.type === 'assistant') {
      if (message.error) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: message.error, code: 'CODEBUDDY_ERROR' } } }
        return { awaitingTool: false, ended: true }
      }
      for (const [index, block] of message.message.content.entries()) {
        if (block.type === 'text') {
          yield { type: 'block-end', index, block: { type: 'text', text: block.text } }
        } else if (block.type === 'thinking') {
          yield { type: 'block-end', index, block: { type: 'reasoning', text: block.thinking } }
        } else if (block.type === 'tool_use') {
          sawToolCall = true
          bridge.noteToolCall(block.id)
          yield {
            type: 'block-end',
            index,
            block: {
              type: 'tool-call',
              id: toolCallId(block.id),
              name: block.name,
              arguments: argumentBuffers.get(index) || JSON.stringify(block.input ?? {}),
            },
          }
        }
      }
      if (!sawToolCall && message.message.stop_reason === 'tool_use') sawToolCall = true
      // A tool-call turn ends here: control returns to the Harness loop, which
      // executes the tools and calls again with their results.
      if (sawToolCall) {
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return { awaitingTool: true, ended: false }
      }
      continue
    }

    if (message.type === 'result') {
      yield { type: 'usage', usage: mapUsage(message.usage) }
      if (message.is_error || message.subtype !== 'success') {
        const detail = message.subtype === 'success'
          ? 'CodeBuddy reported an error'
          : message.errors?.join('; ') ?? message.subtype
        yield { type: 'finish', reason: { kind: 'error', failure: { message: detail, code: 'CODEBUDDY_ERROR' } } }
      } else {
        yield { type: 'finish', reason: mapStopReason(sawToolCall ? 'tool_use' : 'end_turn') }
      }
      return { awaitingTool: sawToolCall, ended: true }
    }
  }

  yield {
    type: 'finish',
    reason: callerSignal?.aborted
      ? { kind: 'aborted', failure: { message: 'CodeBuddy query aborted', code: 'ABORTED' } }
      : sawToolCall
        ? { kind: 'tool-calls' }
        : { kind: 'error', failure: { message: 'CodeBuddy query ended without a result', code: 'STREAM_CLOSED' } },
  }
  return { awaitingTool: sawToolCall, ended: true }
}
