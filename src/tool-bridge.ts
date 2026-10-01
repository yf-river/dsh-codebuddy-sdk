/**
 * Present the Harness tool declarations to CodeBuddy as an in-process MCP
 * server.
 *
 * The Harness executes tools in its own agent loop, not inside this adapter,
 * so a handler invoked by CodeBuddy records the call and resolves immediately
 * with a placeholder. The real execution happens after this turn's
 * `tool-calls` finish lets the loop take over; its result arrives in the next
 * `stream()` call's message history.
 */

import { createSdkMcpServer, tool, type SdkMcpServerResult } from '@tencent-ai/agent-sdk'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { MCP_SERVER_NAME } from './convert.js'
import { jsonSchemaToZodShape } from './zod-shape.js'

export interface ToolInvocation {
  name: string
  input: unknown
}

export interface ToolBridge {
  server: SdkMcpServerResult
  /** Invocations recorded this turn, in call order. */
  invocations: ToolInvocation[]
}

/**
 * Build the MCP server for one turn. Handlers must not await the Harness:
 * the Harness cannot execute a tool until this turn ends, so blocking here
 * would deadlock the turn it is waiting on.
 */
export function createToolBridge(tools: readonly ToolSchema[]): ToolBridge {
  const invocations: ToolInvocation[] = []
  const server = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '1.0.0',
    tools: tools.map((schema) => tool(
      schema.name,
      schema.description,
      jsonSchemaToZodShape(schema.parameters),
      // The shape was translated from the Harness schema, so the dictionary
      // is structurally the declared arguments.
      async (args): Promise<CallToolResult> => {
        invocations.push({ name: schema.name, input: args })
        return { content: [{ type: 'text', text: 'dispatched' }] }
      },
    )),
  })
  return { server, invocations }
}
