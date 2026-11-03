import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import type { Config } from './index.js'
import { runWorker } from './runtime.js'
import { usageOf } from './stream.js'

export interface SearchUsageEvent {
  model: string
  query: string
  usage?: ReturnType<typeof usageOf>
  sourceCount?: number
  failed?: true
}

export function searchResult(raw: unknown): WebSearchResult {
  const result = raw as { type?: string; query?: string; results?: { url?: unknown; title?: unknown; snippet?: unknown }[] }
  if (!result || result.type !== 'web_search_tool_result' || !Array.isArray(result.results)) {
    throw new WebError('CodeBuddy 未返回结构化搜索结果', 'WEB_PROVIDER_ERROR')
  }
  const seen = new Set<string>()
  const sources = result.results.flatMap(item => {
    if (typeof item?.url !== 'string' || !URL.canParse(item.url)) return []
    const url = new URL(item.url)
    if (!['https:', 'http:'].includes(url.protocol) || seen.has(item.url)) return []
    seen.add(item.url)
    return [{ url: item.url, ...(typeof item.title === 'string' ? { title: item.title } : {}), ...(typeof item.snippet === 'string' ? { snippet: item.snippet } : {}) }]
  })
  if (result.results.length && !sources.length) throw new WebError('CodeBuddy 搜索结果没有有效来源 URL', 'WEB_PROVIDER_ERROR')
  return { sources, truncated: false }
}

export class CodeBuddySearchProvider implements WebSearchProvider {
  readonly id = 'codebuddy'
  private readonly active = new Set<ReturnType<typeof runWorker>>()
  private disposed = false
  constructor(private readonly config: Config, private readonly record: (event: SearchUsageEvent) => void) {}
  available(): boolean { return !this.disposed }
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    signal?.throwIfAborted()
    if (this.disposed) throw new WebError('CodeBuddy 搜索已关闭', 'WEB_PROVIDER_UNAVAILABLE')
    const model = this.config.searchModel ?? 'hy4-preview-ioa'
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(90000)])
    const worker = runWorker({ model, cwd: this.config.cwd ?? process.cwd(), system: 'Use the WebSearch tool once. Do not use other tools.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `Search the web. You must call WebSearch exactly once with query ${JSON.stringify(request.query)}. Do not answer without searching.` }] }],
      tools: [], maxTokens: 1024, ...(model === 'deepseek-v4.1-flash' ? { effort: 'high' } : {}), search: { query: request.query } }, bounded)
    this.active.add(worker)
    let raw: unknown, usage: ReturnType<typeof usageOf>
    try {
      for await (const message of worker.messages()) {
        if (message.event?.usage) usage = usageOf(message.event.usage) ?? usage
        if (message.type === 'web_search_result') raw = message.searchResult
      }
      await worker.verify()
      const result = searchResult(raw)
      this.record({ model, query: request.query, ...(usage ? { usage } : {}), sourceCount: result.sources.length })
      return result
    } catch (error) {
      this.record({ model, query: request.query, ...(usage ? { usage } : {}), failed: true })
      if (bounded.aborted) throw new WebError('CodeBuddy 搜索已取消或超时', signal?.aborted ? 'WEB_ABORTED' : 'WEB_PROVIDER_ERROR', { cause: error })
      if (error instanceof WebError) throw error
      throw new WebError(error instanceof Error ? error.message : 'CodeBuddy 搜索失败', 'WEB_PROVIDER_ERROR', { cause: error })
    } finally { worker.stop(); await worker.done; this.active.delete(worker) }
  }
  async dispose(): Promise<void> {
    this.disposed = true
    for (const worker of this.active) worker.stop()
    await Promise.all([...this.active].map(worker => worker.done))
  }
}
