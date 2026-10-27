import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

const PREFIX = 'mcp__custom_tools__'
export class CodeBuddyToolBridge {
  private readonly names: Set<string>
  private readonly ids = new Set<string>()
  constructor(readonly tools: readonly ToolSchema[]) {
    this.names = new Set(tools.map(tool => tool.name))
    if (this.names.size !== tools.length) throw new Error('工具名称重复')
  }
  harnessName(name: string): string {
    const value = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name
    if (!this.names.has(value)) throw new Error(`模型调用了未声明的工具 ${name}`)
    return value
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
      tools: this.tools.map(tool => ({ name: tool.name, description: tool.description,
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
