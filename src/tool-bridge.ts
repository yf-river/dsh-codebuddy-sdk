import { createHash } from 'node:crypto'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

const PREFIXES = ['mcp__custom_tools__', 'mcp__custom_tools_', 'mcp__custom_flow_tools__', 'mcp__custom_flow_tools_']
// CodeBuddy 会改写连字符；声明和历史共用稳定别名，哈希区分名称归一化后的碰撞。
export function codeBuddyToolName(name: string): string {
  if (/^[a-zA-Z0-9_]{1,64}$/.test(name)) return name
  const stem = name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 45)
  return `${stem}_${createHash('sha256').update(name).digest('hex').slice(0, 16)}`
}
function stripMcpPrefix(name: string): string {
  for (const prefix of PREFIXES) if (name.startsWith(prefix)) return name.slice(prefix.length)
  return name
}
/** 大小写和下划线差异可能来自模型输出；只在别名唯一时启用，避免误映射。 */
function canonicalToolName(name: string): string {
  return name.toLowerCase().replace(/_/g, '')
}
export class UnknownToolError extends Error {
  readonly code = 'CODEBUDDY_UNKNOWN_TOOL'
  constructor(readonly toolName: string) {
    super(`模型调用了当前工具列表中没有的工具 ${toolName}。请使用当前工具名重试；如果该工具刚被移除，请重新打开会话。`)
    this.name = 'UnknownToolError'
  }
}
export class CodeBuddyToolBridge {
  private readonly names = new Map<string, string>()
  private readonly ids = new Set<string>()
  private readonly canonical = new Map<string, string>()
  private readonly ambiguousCanonical = new Set<string>()
  constructor(readonly tools: readonly ToolSchema[]) {
    for (const tool of tools) {
      const name = codeBuddyToolName(tool.name)
      if (this.names.has(name)) throw new Error('工具名称重复或别名冲突')
      this.names.set(name, tool.name)
      const canonical = canonicalToolName(name)
      if (this.canonical.has(canonical)) this.ambiguousCanonical.add(canonical)
      else this.canonical.set(canonical, name)
    }
  }
  harnessName(name: string): string {
    const value = stripMcpPrefix(name)
    const exact = this.names.get(value)
    if (exact !== undefined) return exact
    const canonical = canonicalToolName(value)
    if (this.ambiguousCanonical.has(canonical)) throw new UnknownToolError(name)
    const alias = this.canonical.get(canonical)
    const original = alias === undefined ? undefined : this.names.get(alias)
    if (original === undefined) throw new UnknownToolError(name)
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
