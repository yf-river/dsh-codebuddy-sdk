import { LlmError, ProviderRequestId, isContextWindowExceededError, isQuotaExceededError } from '@deepseek-ai/dsh-llm'

export interface Failure {
  code: string
  message: string
  status?: number
  providerRetryAfterMs?: number
  requestId?: string
}

// 只传递公开错误中的诊断字段；不序列化请求、响应、headers 或认证对象。
export function failureOf(value: unknown): Failure {
  const seen = new Set<unknown>()
  const facts: Record<string, unknown>[] = []
  function visit(current: unknown, depth = 0): void {
    if (depth > 6 || current == null || seen.has(current)) return
    seen.add(current)
    if (typeof current === 'string') {
      try { visit(JSON.parse(current), depth + 1) } catch { facts.push({ message: current }) }
    } else if (typeof current === 'object') {
      const item = current as Record<string, unknown>
      facts.push(item)
      for (const key of ['error', 'data', 'cause', 'failure']) visit(item[key], depth + 1)
      if (typeof item.message === 'string' && item.message.trim().startsWith('{')) visit(item.message, depth + 1)
    }
  }
  visit(value)
  const string = (key: string) => facts.map(item => item[key]).find(v => typeof v === 'string' && v.length) as string | undefined
  const number = (...keys: string[]) => facts.flatMap(item => keys.map(key => item[key])).find(v => typeof v === 'number' && Number.isFinite(v)) as number | undefined
  const message = string('message') ?? 'CodeBuddy 请求失败'
  const original = string('code')
  const rawStatus = number('status', 'statusCode', 'httpStatusCode')
  const status = rawStatus !== undefined && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined
  const detail = facts.flatMap(item => ['code', 'type', 'message'].map(key => typeof item[key] === 'string' ? item[key] : '')).join(' ')
  let code = original ?? 'CODEBUDDY_ERROR'
  if (isContextWindowExceededError(detail)) code = 'CONTEXT_WINDOW_EXCEEDED'
  else if (isQuotaExceededError(detail) || status === 402) code = 'QUOTA'
  else if (status === 401 || status === 403 || /\b(authentication_error|permission_error|AuthenticationRequiredError)\b/i.test(detail)) code = 'AUTH'
  else if (status === 429 || /\brate_limit_error\b/i.test(detail)) code = 'RATE_LIMIT'
  else if (status !== undefined && status >= 500) code = 'SERVER'
  else if (status === 400 || status === 413) code = 'INVALID_REQUEST'
  else if (facts.some(item => item.isStreamTimeout === true)) code = 'TIMEOUT'
  else if (facts.some(item => item.isNetworkError === true)) code = 'NETWORK'
  else if (/\b(ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)\b/.test(detail) || message === 'fetch failed') code = 'NETWORK'
  const retry = number('providerRetryAfterMs')
  const requestId = string('requestId') ?? string('requestID')
  return { code, message,
    ...(status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(retry !== undefined && retry > 0 ? { providerRetryAfterMs: retry } : {}),
    ...(requestId ? { requestId } : {}),
  }
}

export function llmError(value: unknown): LlmError {
  if (value instanceof LlmError) return value
  const { message, code, requestId, ...options } = failureOf(value)
  return new LlmError(message, code, { ...options, ...(requestId ? { requestId: ProviderRequestId(requestId) } : {}) })
}
