import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, ReasoningEffortId, RetryPolicySchema, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { unstable_v2_createSession, type Session, type SessionOptions } from '@tencent-ai/agent-sdk'
import z from '@deepseek-ai/schemastery'
import { modelsFromRaw, type CodeBuddyModel } from './models.js'
import { translateStep } from './stream.js'
import { CodeBuddyToolBridge } from './tool-bridge.js'
import { selectTools, type ToolPolicy } from './tool-policy.js'
import { requestHistory, unsupported } from './history.js'
import { llmError } from './errors.js'
import { runWorker } from './runtime.js'
import { readImages } from './images.js'
import { CodeBuddySearchProvider } from './web.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'

export interface Config {
  provider?: string
  model?: string
  pathToCodebuddyCode?: string
  cwd?: string
  contextWindow?: number
  maxTokens?: number
  searchModel?: string
  toolPolicy?: ToolPolicy
  retryPolicy?: RetryPolicyConfig
}
export const Config: z<Config> = z.object({
  provider: z.string().description('Provider route (default codebuddy)'),
  model: z.string().description('Default exact model id (default deepseek-v4.1-flash)'),
  pathToCodebuddyCode: z.string().description('Deprecated: remove this option when using the Server runtime'),
  cwd: z.string().description('Working directory for the CLI'),
  contextWindow: z.number().description('Context window override'),
  maxTokens: z.number().description('Maximum output tokens sent to the CLI'),
  searchModel: z.string().description('Model for auxiliary native web search (default hy4-preview-ioa)'),
  toolPolicy: z.object({
    allow: z.array(z.string()).description('Tool name patterns allowed to reach the model; omitted means all'),
    deny: z.array(z.string()).description('Tool name patterns removed after allow; deny wins'),
  }).description('Optional model-visible tool filter; `*` is the only wildcard'),
  retryPolicy: RetryPolicySchema.description('Model-request retry policy for this route; omitted uses transient defaults'),
})
export const name = 'codebuddy'
export const inject = ['llm']

/** 选择器里用 `codebuddy-` 前缀区分 CodeBuddy 额度与官方 DeepSeek 路由；模型 id 不变。 */
function displayName(name: string): string {
  return name.startsWith('deepseek-') ? `codebuddy-${name.slice('deepseek-'.length)}` : name
}

class CodeBuddyAdapter extends LlmAdapter {
  private models: CodeBuddyModel[] = []
  private discovery?: Promise<void>
  private discoverySession?: Session
  private readonly active = new Set<ReturnType<typeof runWorker>>()
  private readonly retryPolicy: ResolvedRetryPolicy
  private disposed = false

  constructor(private readonly config: Config, private readonly attachments: () => AttachmentStore | undefined) {
    super()
    if (config.pathToCodebuddyCode) unsupported('pathToCodebuddyCode 不适用于 Server 接口；请移除此配置，使用锁定的官方运行时')
    this.retryPolicy = resolveRetryPolicy(config.retryPolicy, 'codebuddy: retryPolicy')
  }
  override providerInfo(provider: string) { return { id: provider, name: 'CodeBuddy' } }
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy { return this.retryPolicy }

  private sdkOptions(): SessionOptions {
    return {
      cwd: this.config.cwd ?? process.cwd(), executable: process.execPath,
      pathToCodebuddyCode: this.config.pathToCodebuddyCode,
      tools: [], strictMcpConfig: true, settingSources: [],
      systemPrompt: ' ', permissionMode: 'default',
      env: {
        DISABLE_AUTOUPDATER: '1', CODEBUDDY_DISABLE_AUTO_MEMORY: '1',
        CODEBUDDY_CODE_DISABLE_AUTO_MEMORY: '1', CODEBUDDY_PRE_MESSAGE_COMPACT: '0',
        CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1',
        // 固定 SDK 所带 CLI 的开关，禁止额外注入 CODEBUDDY.md / rules。
        CODEBUDDY_DISABLE_SYSTEM_REMINDER_MD: '1',
      },
    }
  }

  private async refreshModels(): Promise<void> {
    this.discovery ??= (async () => {
      const discovery = unstable_v2_createSession(this.sdkOptions())
      this.discoverySession = discovery
      try {
        await discovery.connect()
        this.models = modelsFromRaw(await discovery.getAvailableModelsRaw())
      } finally { discovery.close(); if (this.discoverySession === discovery) this.discoverySession = undefined }
    })().catch(error => { this.discovery = undefined; throw error })
    await this.discovery
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    await this.refreshModels()
    return this.models.map(model => ({ provider, id: model.id, name: displayName(model.name), inputModalities: model.supportsImages ? ['text', 'image'] : ['text'] }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    await this.refreshModels()
    const found = this.models.find(candidate => candidate.id === model)
    if (!found) unsupported(`CodeBuddy 模型目录中没有精确模型 id：${model}`)
    const contextWindow = this.config.contextWindow ?? found.contextWindow
    return {
      provider, id: found.id, name: found.name, inputModalities: found.supportsImages ? ['text', 'image'] : ['text'],
      ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
      defaultMaxTokens: this.config.maxTokens ?? found.maxTokens,
      ...(found.efforts?.length ? { reasoning: {
        efforts: found.efforts.map(id => ({ id: ReasoningEffortId(id), name: id })),
        ...(found.defaultEffort ? { defaultEffort: ReasoningEffortId(found.defaultEffort) } : {}),
      } } : {}),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.disposed) unsupported('CodeBuddy provider 已关闭')
    options.signal?.throwIfAborted()
    if (options.temperature !== undefined || options.stop?.length) unsupported('官方接口尚未验证 temperature / stop 透传；请移除这些参数')
    const model = options.model || this.config.model || 'deepseek-v4.1-flash'
    if (/^(codebuddy|default|auto)$/i.test(model)) unsupported('请指定精确 CodeBuddy 模型 id')
    const maxTokens = options.maxTokens ?? this.config.maxTokens
    if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) unsupported('maxTokens 必须是正整数')
    const effort = options.reasoningEffort
    if (effort !== undefined && !['off', 'low', 'medium', 'high', 'xhigh', 'max', 'minimal'].includes(effort)) unsupported(`不支持 reasoningEffort=${effort}`)
    const hasImages = options.messages.some(message => message.content.some(block => block.type === 'image' && !block.offloaded))
    if (hasImages) {
      await this.refreshModels()
      if (!this.models.find(candidate => candidate.id === model)?.supportsImages) unsupported(`CodeBuddy 模型 ${model} 未声明图片能力`)
    }
    const images = await readImages(options, this.attachments(), this.models.find(candidate => candidate.id === model)?.maxImageCount)
    const history = requestHistory(options, images)
    const tools = selectTools(options.tools ?? [], this.config.toolPolicy)
    if (tools.length === 0) throw new LlmError('工具策略过滤后没有可用工具', 'CODEBUDDY_NO_TOOLS')
    const bridge = new CodeBuddyToolBridge(tools)
    const worker = runWorker({ ...history, model, cwd: this.config.cwd ?? process.cwd(), tools, maxTokens, effort }, options.signal)
    this.active.add(worker)
    const startedAt = performance.now()
    let reportedModel: string | undefined
    try {
      const step = translateStep(worker.messages(), bridge, model)
      while (true) {
        const next = await step.next()
        if (next.done) { reportedModel = next.value.model; break }
        const chunk = next.value as StreamChunk
        if (chunk.type === 'finish') {
          const end = await step.next()
          if (!end.done) throw new Error('模型 finish 后仍有内容')
          reportedModel = end.value.model
          const cleanup = await worker.verify()
          yield { ...chunk, replayState: { response: { kind: 'codebuddy-server', version: 2, requestedModel: model, reportedModel, durationMs: Math.round(performance.now() - startedAt), finishReason: chunk.reason.kind, cleanup } } }
          return
        } else yield chunk
      }
    } catch (error) {
      if (options.signal?.aborted) yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'CodeBuddy 请求已取消', code: 'ABORTED' } } }
      else if (error instanceof LlmError) throw error
      else throw llmError(error)
    } finally { worker.stop(); await worker.done; this.active.delete(worker) }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.discoverySession?.close()
    for (const worker of this.active) worker.stop()
    await Promise.all([...this.active].map(worker => worker.done))
    this.active.clear()
  }
}

export function apply(ctx: Context, config: Config): void {
  const adapter = new CodeBuddyAdapter(config, () => ctx.get('attachments'))
  ctx.llm.registerAdapter([config.provider ?? name], adapter)
  ctx.effect(() => () => adapter.dispose())
  ctx.inject(['web'], webCtx => {
    const provider = new CodeBuddySearchProvider(config, event => {
      const agents = webCtx.get('agents') as { currentInitiator(): { session: { id: string } } | undefined } | undefined
      webCtx.logger.info('codebuddy/search-usage %s', JSON.stringify({ sessionId: agents?.currentInitiator()?.session.id,
        model: event.model, usage: event.usage, sourceCount: event.sourceCount, failed: event.failed }))
    })
    webCtx.effect(() => webCtx.web.registerSearchProvider(provider))
    webCtx.effect(() => () => provider.dispose())
  })
}
