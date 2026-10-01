/**
 * CodeBuddy (Tencent Agent SDK) as a DeepSeek Harness LLM provider.
 *
 * The Harness owns tool execution, so one conversation is driven one step at a
 * time: a `stream()` call that ends on a tool call returns `tool-calls`, the
 * Harness runs the tool, and the next `stream()` call delivers the result.
 *
 * One CodeBuddy CLI query spans the whole conversation. The MCP handlers it
 * invokes stay pending across steps; the next step resolves them with the
 * Harness's real tool results, which lets the CLI continue the same turn. Only
 * the first step sends a prompt — later steps are continuations of it.
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { query, type Message as CodeBuddyMessage, type ModelInfo } from '@tencent-ai/agent-sdk'
import z from '@deepseek-ai/schemastery'
import { PROVIDER_ID, lastUserText } from './convert.js'
import { FALLBACK_MODELS, modelsFromSdk, resolveModel, type CodeBuddyModel } from './models.js'
import { translateStep } from './stream.js'
import { CodeBuddyToolBridge } from './tool-bridge.js'
import { QueryReaper } from './teardown.js'

export interface Config {
  /** Provider route advertised to the harness (default `codebuddy`). */
  provider?: string
  /** Default model id (default `codebuddy`). */
  model?: string
  /** Path to the CodeBuddy CLI when it is not on `PATH`. */
  pathToCodebuddyCode?: string
  /** Working directory for the CLI; defaults to the process cwd. */
  cwd?: string
  /** Permission mode handed to the CLI. Defaults to `bypassPermissions`. */
  permissionMode?: string
  /** Context window override for every model. */
  contextWindow?: number
  /** Max output tokens override for every model. */
  maxTokens?: number
}

export const Config: z<Config> = z.object({
  provider: z.string().description('Provider route (default codebuddy)'),
  model: z.string().description('Default model id (default codebuddy)'),
  pathToCodebuddyCode: z.string().description('Path to the CodeBuddy CLI'),
  cwd: z.string().description('Working directory for the CLI'),
  permissionMode: z.string().description('Permission mode passed to the CLI'),
  contextWindow: z.number().description('Context window override for every model'),
  maxTokens: z.number().description('Max output tokens override for every model'),
})

export const name = 'codebuddy'
export const inject = ['llm']

/** One live conversation: the CLI query plus the tool bridge spanning its steps. */
interface Conversation {
  iterator: AsyncIterator<CodeBuddyMessage>
  bridge: CodeBuddyToolBridge
  reaper: QueryReaper
  /** Tool call ids the step that just ended advertised, in order. */
  awaiting: string[]
  controller: AbortController
}

interface ToolResultLike {
  role: 'tool'
  content: Array<{ type: string; text?: string }>
  source: { kind?: string; callId?: string }
  isError?: boolean
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

/** Results the Harness appended for the calls the previous step advertised. */
function toolResultsFrom(
  options: GenerateOptions,
  awaiting: readonly string[],
): Map<string, { content: string; isError?: boolean }> {
  const wanted = new Set(awaiting)
  const results = new Map<string, { content: string; isError?: boolean }>()
  for (const candidate of options.messages as unknown as ToolResultLike[]) {
    if (candidate.role !== 'tool') continue
    const callId = candidate.source.callId
    if (callId === undefined || !wanted.has(callId)) continue
    const content = candidate.content
      .map((block) => block.type === 'text' ? block.text ?? '' : `[${block.type}]`)
      .filter(Boolean)
      .join('\n')
    results.set(callId, { content, ...candidate.isError === true ? { isError: true } : {} })
  }
  return results
}

class CodeBuddyAdapter extends LlmAdapter {
  private models: CodeBuddyModel[] = [...FALLBACK_MODELS]
  private discovered = false
  private readonly conversations = new Map<string, Conversation>()

  constructor(private readonly config: Config) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'CodeBuddy' }
  }

  /** Adopt the CLI's own catalog once; discovery costs a CLI start. */
  private async refreshModels(): Promise<void> {
    if (this.discovered) return
    this.discovered = true
    const discovery = query({ prompt: '', options: { tools: [] } })
    const reaper = new QueryReaper(discovery, 'discover')
    try {
      const supported: ModelInfo[] = await discovery.supportedModels()
      const mapped = modelsFromSdk(supported)
      if (mapped.length > 0) this.models = mapped
    } catch {
      // Best-effort: the fallback catalog keeps the route usable and the CLI
      // reports the real model error on the first request.
    } finally {
      await reaper.close()
    }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    await this.refreshModels()
    return this.models.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: [...model.input],
    }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    await this.refreshModels()
    const resolved = resolveModel(this.models, model) ?? this.models.find((candidate) => candidate.id === model) ?? {
      id: model,
      name: model,
      reasoning: false,
      input: ['text'] as Array<'text' | 'image'>,
      contextWindow: this.config.contextWindow ?? 131_072,
      maxTokens: this.config.maxTokens ?? 8192,
    }
    return {
      provider,
      id: resolved.id,
      name: resolved.name,
      inputModalities: [...resolved.input],
      context: { contextWindow: this.config.contextWindow ?? resolved.contextWindow },
      defaultMaxTokens: this.config.maxTokens ?? resolved.maxTokens,
    }
  }

  private startConversation(options: GenerateOptions, model: string): Conversation {
    const bridge = new CodeBuddyToolBridge(options.tools ?? [])
    const controller = new AbortController()
    if (options.signal?.aborted) controller.abort()
    else options.signal?.addEventListener('abort', () => controller.abort(), { once: true })
    const child = query({
      prompt: lastUserText(options.messages) || '[continue]',
      options: {
        cwd: this.config.cwd ?? process.cwd(),
        abortController: controller,
        tools: [],
        permissionMode: (this.config.permissionMode ?? 'bypassPermissions') as 'bypassPermissions',
        includePartialMessages: true,
        systemPrompt: options.system,
        model,
        ...this.config.pathToCodebuddyCode === undefined
          ? {}
          : { pathToCodebuddyCode: this.config.pathToCodebuddyCode },
        ...(options.tools ?? []).length === 0
          ? {}
          : { mcpServers: { [bridge.server.name]: bridge.server } },
      },
    })
    return {
      iterator: child[Symbol.asyncIterator](),
      bridge,
      reaper: new QueryReaper(child, `conversation:${model}`),
      awaiting: [],
      controller,
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const provider = options.provider || this.config.provider || PROVIDER_ID
    const model = options.model || this.config.model || FALLBACK_MODELS[0]!.id
    // Keyed by session so concurrent subagents each own an independent CLI and
    // do not resolve one another's pending tool calls.
    const key = options.sessionId ?? '__default__'
    let conversation = this.conversations.get(key)
    if (conversation === undefined) {
      conversation = this.startConversation(options, model)
      this.conversations.set(key, conversation)
    }

    // Resolve the handlers the previous step left waiting. The CLI continues
    // the same turn as soon as the Harness's real result arrives.
    const results = toolResultsFrom(options, conversation.awaiting)
    for (const callId of conversation.awaiting) {
      const result = results.get(callId)
      if (result === undefined) continue
      conversation.bridge.deliver(callId, {
        content: [{ type: 'text', text: result.content }],
        ...result.isError === true ? { isError: true } : {},
      })
    }
    conversation.awaiting = []

    try {
      const step: AsyncGenerator<StreamChunk, import('./stream.js').StepStatus, void> =
        translateStep(conversation.iterator, conversation.bridge, options.signal)
      while (true) {
        const next: IteratorResult<StreamChunk, import('./stream.js').StepStatus> = await step.next()
        if (next.done) {
          if (next.value.ended) await this.finishConversation(key)
          break
        }
        const value = next.value as StreamChunk | import('./stream.js').StepStatus
        if (!('type' in value)) break
        const chunk: StreamChunk = value
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          conversation.awaiting.push(chunk.block.id)
        }
        yield chunk
      }
    } catch (error) {
      conversation.bridge.failAll(`CodeBuddy provider "${provider}" failed: ${errorMessage(error)}`)
      await this.finishConversation(key)
      throw new LlmError(`CodeBuddy provider "${provider}" failed: ${errorMessage(error)}`, 'CODEBUDDY_ERROR', {
        cause: error instanceof Error ? error : undefined,
      })
    }
  }

  private async finishConversation(key: string): Promise<void> {
    const conversation = this.conversations.get(key)
    if (conversation === undefined) return
    this.conversations.delete(key)
    conversation.bridge.failAll('conversation ended')
    await conversation.reaper.close()
  }

  /** Release every CLI when the plugin is disposed. */
  async dispose(): Promise<void> {
    await Promise.all([...this.conversations.keys()].map((key) => this.finishConversation(key)))
  }
}

export function apply(ctx: Context, config: Config): void {
  const provider = config.provider ?? PROVIDER_ID
  const adapter = new CodeBuddyAdapter(config)
  ctx.llm.registerAdapter([provider], adapter)
  ctx.effect(() => () => { void adapter.dispose() })
}
