/**
 * Bridge the Harness tool declarations to CodeBuddy through an in-process SDK
 * MCP server.
 *
 * The Harness owns tool execution: a `stream()` call ends at the tool call,
 * its loop runs the tool, and the next `stream()` call carries the result.
 * The MCP handler therefore blocks on a promise that the *next* step resolves
 * by matching the tool call id against the result the Harness just appended.
 * Returning eagerly instead would let CodeBuddy fabricate a result and
 * continue the conversation unobserved by the Harness loop.
 */

import { createSdkMcpServer, tool, type SdkMcpServerResult } from '@tencent-ai/agent-sdk'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { MCP_SERVER_NAME } from './convert.js'
import { jsonSchemaToZodShape } from './zod-shape.js'

export interface ToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  isError?: boolean
}

interface PendingCall {
  name: string
  resolve: (result: ToolResult) => void
}

export interface ToolBridge {
  server: SdkMcpServerResult
  /** Tool call ids this turn advertised, in call order. */
  readonly toolCallIds: string[]
  /** Resolve every waiting handler; used on abort and query teardown. */
  failAll(message: string): void
}

function toCallToolResult(result: ToolResult): CallToolResult {
  const content = result.content.map((block) => block.type === 'text'
    ? { type: 'text' as const, text: block.text }
    : {
      type: 'image' as const,
      data: block.data,
      mimeType: block.mimeType,
    })
  return { content, ...result.isError === true ? { isError: true } : {} }
}

/**
 * One bridge per CodeBuddy query. The same instance must span the step that
 * advertises the tools and the step that delivers their results.
 */
export class CodeBuddyToolBridge {
  private readonly pending = new Map<string, PendingCall>()
  private readonly results = new Map<string, ToolResult>()
  private readonly ids: string[] = []
  private index = 0

  readonly server: SdkMcpServerResult

  constructor(tools: readonly ToolSchema[]) {
    this.server = createSdkMcpServer({
      name: MCP_SERVER_NAME,
      version: '1.0.0',
      tools: tools.map((schema) => tool(
        schema.name,
        schema.description,
        jsonSchemaToZodShape(schema.parameters),
        async (): Promise<CallToolResult> => {
          // The control protocol does not expose the model's tool-call id to
          // the handler, so ids are matched positionally within the turn: the
          // Harness emits them in the same order the MCP server receives them.
          const id = this.ids[this.index]
          this.index += 1
          if (id === undefined) return toCallToolResult({ content: [{ type: 'text', text: 'tool call could not be matched' }], isError: true })
          const queued = this.results.get(id)
          if (queued !== undefined) {
            this.results.delete(id)
            return toCallToolResult(queued)
          }
          return await new Promise<CallToolResult>((resolve) => {
            this.pending.set(id, {
              name: schema.name,
              resolve: (result) => resolve(toCallToolResult(result)),
            })
          })
        },
      )),
    })
  }

  /** Record a tool-call id as it streams, preserving call order. */
  noteToolCall(id: string): void {
    this.ids.push(id)
  }

  /** Resolve a waiting handler, or queue the result for one that has not arrived. */
  deliver(id: string, result: ToolResult): boolean {
    const pending = this.pending.get(id)
    if (pending !== undefined) {
      this.pending.delete(id)
      pending.resolve(result)
      return true
    }
    this.results.set(id, result)
    return false
  }

  /** Unblock every waiting handler so a torn-down query can exit. */
  failAll(message: string): void {
    for (const pending of this.pending.values()) {
      pending.resolve({ content: [{ type: 'text', text: message }], isError: true })
    }
    this.pending.clear()
  }

  get waiting(): number {
    return this.pending.size
  }
}

/** Build a bridge; kept as a function for call sites that only need the server. */
export function createToolBridge(tools: readonly ToolSchema[]): CodeBuddyToolBridge {
  return new CodeBuddyToolBridge(tools)
}
