import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

export function unsupported(message: string): never { throw new LlmError(message, 'CODEBUDDY_UNSUPPORTED') }
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
}

// 每次按 DSH 当前投影重新构造原生消息，旧 SDK 会话元数据不参与恢复。
export function requestHistory(options: GenerateOptions): { system: string; input: unknown[] } {
  let offset = 0
  const system: string[] = []
  while (options.messages[offset]?.role === 'system') {
    for (const block of options.messages[offset]!.content) {
      if (block.type !== 'text') unsupported('系统提示词只支持文本')
      system.push(block.text)
    }
    offset++
  }
  const input: unknown[] = []
  const pending = new Map<string, string>()
  const seen = new Set<string>()
  for (const message of options.messages.slice(offset)) {
    if (message.role === 'tool') {
      const callId = (message.source as { callId?: string })?.callId
      const name = callId && pending.get(callId)
      if (!callId || !name) unsupported('工具结果缺少、重复或无法匹配调用 ID')
      const output = message.content.map(block => {
        if (block.type !== 'text') unsupported('工具结果只支持文本')
        return block.text
      }).join('\n')
      input.push({ type: 'function_call_result', callId, name: `mcp__custom_tools__${name}`, output, status: 'completed',
        ...(message.isError ? { providerData: { isError: true } } : {}) })
      pending.delete(callId)
      continue
    }
    if (pending.size) unsupported('工具调用缺少完整结果，不能发送后续消息')
    if (!['user', 'assistant', 'developer', 'system'].includes(message.role)) unsupported(`不支持消息角色 ${message.role}`)
    const reasoning = message.role === 'assistant' ? message.content.flatMap(block => block.type === 'reasoning' ? [block.text] : []).join('') : ''
    const providerData = reasoning ? { reasoning_content: reasoning } : undefined
    let emitted = false
    let content: unknown[] = []
    const flush = () => {
      if (!content.length) return
      input.push({ type: 'message', role: message.role,
        ...(message.role === 'assistant' ? { status: 'completed', ...(providerData ? { providerData } : {}) } : {}), content })
      emitted = true
      content = []
    }
    for (const block of message.content) {
      if (block.type === 'text') content.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: block.text,
        ...(message.role === 'assistant' ? { annotations: [] } : {}) })
      else if (block.type === 'reasoning' && message.role === 'assistant') {
        // 推理进入原生 assistant 字段，不作为普通对话文本发送。
      } else if (block.type === 'tool-call' && message.role === 'assistant') {
        flush()
        if (!block.id || seen.has(block.id)) unsupported('工具调用 ID 缺失或重复')
        try { JSON.parse(block.arguments) } catch { unsupported('工具参数不是有效 JSON') }
        seen.add(block.id); pending.set(block.id, block.name)
        input.push({ type: 'function_call', callId: block.id, name: `mcp__custom_tools__${block.name}`, arguments: block.arguments, status: 'completed', ...(providerData ? { providerData } : {}) })
        emitted = true
      } else unsupported(`暂不支持 ${message.role} 中的 ${block.type} 内容`)
    }
    flush()
    if (providerData && !emitted) input.push({ type: 'message', role: 'assistant', status: 'completed', content: [], providerData })
  }
  if (pending.size) unsupported('工具调用缺少完整结果')
  if (!input.length) unsupported('模型请求没有消息')
  return { system: options.system ?? system.join(''), input }
}
