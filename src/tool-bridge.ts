import { createHash } from 'node:crypto'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

const PREFIX = 'mcp__custom_tools__'
const SINGLE_PREFIX = 'mcp__custom_tools_'
// CodeBuddy 会改写连字符；声明和历史共用稳定别名，哈希区分名称归一化后的碰撞。
export function codeBuddyToolName(name: string): string {
  if (/^[a-zA-Z0-9_]{1,64}$/.test(name)) return name
  const stem = name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 45)
  return `${stem}_${createHash('sha256').update(name).digest('hex').slice(0, 16)}`
}
export class CodeBuddyToolBridge {
  private readonly names = new Map<string, string>()
  private readonly ids = new Set<string>()
  constructor(readonly tools: readonly ToolSchema[]) {
    for (const tool of tools) {
      const name = codeBuddyToolName(tool.name)
      if (this.names.has(name)) throw new Error('工具名称重复或别名冲突')
      this.names.set(name, tool.name)
    }
  }
  harnessName(name: string): string {
    // 部分模型会把 MCP 前缀的最后一个双下划线写成单下划线；仅按已声明别名容错。
    const value = name.startsWith(PREFIX) ? name.slice(PREFIX.length)
      : name.startsWith(SINGLE_PREFIX) ? name.slice(SINGLE_PREFIX.length)
        : name
    const original = this.names.get(value)
    if (original === undefined) throw new Error(`模型调用了未声明的工具 ${name}`)
    return original
  }
  noteToolCall(id: string, name: string, _args: unknown): void {
    this.harnessName(name)
    if (!id || this.ids.has(id)) throw new Error(`工具调用 ID 缺失或重复：${id}`)
    this.ids.add(id)
  }
  async sdkServer(signal: AbortSignal) {
    const { createSdkMcpServer } = await import('@tencent-ai/codebuddy-code/server')
    const server = createSdkMcpServer({ name: 'custom_tools', tools: [] })
    server.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.tools.map(tool => ({ name: codeBuddyToolName(tool.name), description: codeBuddyToolName(tool.name) === tool.name ? tool.description : `${tool.description}\nDSH tool name: ${tool.name}`,
        inputSchema: tool.parameters as { type: 'object'; [key: string]: unknown } })),
    }))
    // 业务工具始终交给 DSH；SDK 只等待本次模型输出结束后的取消。
    server.instance.server.setRequestHandler(CallToolRequestSchema, async request => {
      this.harnessName(request.params.name)
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { isError: true, content: [{ type: 'text', text: 'DSH owns tool execution' }] }
    })
    return { ...server, alwaysLoad: true, defer_loading: false }
  }
}
