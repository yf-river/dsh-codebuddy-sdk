/**
 * Harness → CodeBuddy conversion.
 *
 * The Harness keeps tool arguments as raw JSON strings and tool results as
 * first-class `tool`-role messages; CodeBuddy expects Anthropic-shaped
 * `tool_use`/`tool_result` blocks in `user`/`assistant` turns.
 */

import { pascalCase } from 'change-case'
import type { ContentBlock, GenerateOptions, ToolSchema } from '@deepseek-ai/dsh-llm'

type RequestMessage = GenerateOptions['messages'][number]

export const PROVIDER_ID = 'codebuddy'
export const MCP_SERVER_NAME = 'custom_tools'
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`

const HARNESS_TO_SDK_TOOL_NAME: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export function sanitizeToolId(id: string, cache: Map<string, string>): string {
  const existing = cache.get(id)
  if (existing) return existing
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, '_')
  cache.set(id, clean)
  return clean
}

export function mapHarnessToolNameToSdk(name: string, custom?: Map<string, string>): string {
  if (!name) return ''
  const normalized = name.toLowerCase()
  const mapped = custom?.get(name) ?? custom?.get(normalized)
  if (mapped) return mapped
  if (HARNESS_TO_SDK_TOOL_NAME[normalized]) return HARNESS_TO_SDK_TOOL_NAME[normalized]
  return pascalCase(name)
}

function blocksOf(content: readonly ContentBlock[]): AnthropicContentBlock[] {
  const out: AnthropicContentBlock[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        if (block.text) out.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        break
      case 'image':
        break
      case 'tool-call':
        out.push({ type: 'tool_use', id: block.id, name: block.name, input: parseArguments(block.arguments) })
        break
      default:
        break
    }
  }
  return out
}

function parseArguments(raw: string): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * Convert one request history into the Anthropic-shaped message array the
 * CodeBuddy CLI accepts for session import.
 */
export function convertMessages(
  messages: readonly RequestMessage[],
  customToolNames?: Map<string, string>,
): { messages: AnthropicMessage[]; sanitizedIds: Map<string, string> } {
  const out: AnthropicMessage[] = []
  const sanitizedIds = new Map<string, string>()
  const pendingToolUse = new Set<string>()
  const toolNames = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') {
      const content = blocksOf(message.content).filter(
        (block): block is Extract<AnthropicContentBlock, { type: 'text' | 'image' }> =>
          block.type === 'text' || block.type === 'image',
      )
      if (content.length > 0) out.push({ role: 'user', content })
      continue
    }
    if (message.role === 'assistant') {
      const content = blocksOf(message.content).map((block) => {
        if (block.type !== 'tool_use') return block
        const id = sanitizeToolId(block.id, sanitizedIds)
        toolNames.set(id, block.name)
        pendingToolUse.add(id)
        return { ...block, id, name: mapHarnessToolNameToSdk(block.name, customToolNames) }
      })
      if (content.length > 0) out.push({ role: 'assistant', content })
      continue
    }
    if (message.role === 'tool') {
      const callId = message.source.kind === 'tool' ? message.source.callId : ''
      const id = sanitizeToolId(callId, sanitizedIds)
      pendingToolUse.delete(id)
      const text = message.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      const result: AnthropicContentBlock = {
        type: 'tool_result',
        tool_use_id: id,
        content: text,
        ...(message as { isError?: boolean }).isError === true ? { is_error: true } : {},
      }
      const previous = out.at(-1)
      if (previous?.role === 'user' && Array.isArray(previous.content)) previous.content.push(result)
      else out.push({ role: 'user', content: [result] })
    }
  }
  // A history cut between a tool call and its result cannot be replayed by the
  // CLI; synthesize the missing results so the request stays valid.
  if (pendingToolUse.size > 0) {
    const results: AnthropicContentBlock[] = [...pendingToolUse].map((id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: '[no tool result recorded]',
      is_error: true,
    }))
    const previous = out.at(-1)
    if (previous?.role === 'user' && Array.isArray(previous.content)) previous.content.push(...results)
    else out.push({ role: 'user', content: results })
  }
  return { messages: out, sanitizedIds }
}

export function lastUserText(messages: readonly RequestMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (text) return text
  }
  return ''
}

export function toolSchemasToNames(tools: readonly ToolSchema[] | undefined): string[] {
  return (tools ?? []).map((tool) => tool.name)
}
