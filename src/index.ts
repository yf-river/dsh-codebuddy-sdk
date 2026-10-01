/**
 * CodeBuddy (Tencent Agent SDK) as a DeepSeek Harness LLM provider.
 *
 * One `stream()` call is one Harness step. A step that ends on a tool call
 * yields `{ kind: 'tool-calls' }` and returns; the Harness executes the tool
 * and calls again with the result appended to the message history. The
 * CodeBuddy CLI is therefore invoked per turn and torn down afterwards, which
 * matches the per-step freeze the Harness guarantees callers.
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { query, type Message as CodeBuddyMessage, type ModelInfo } from '@tencent-ai/agent-sdk'
import z from '@deepseek-ai/schemastery'
import { lastUserText, PROVIDER_ID } from './convert.js'
import { FALLBACK_MODELS, modelsFromSdk, resolveModel, type CodeBuddyModel } from './models.js'
import { importSession } from './session-io.js'
import { toStreamChunks } from './stream.js'
import { createToolBridge } from './tool-bridge.js'
import { closeQueryTransport, endQuery } from './teardown.js'

export interface Config {
  /** Provider route advertised to the harness (default `codebuddy`). */
  provider?: string
  /** Default model id (default `codebuddy`). */
  model?: string
  /** Path to the CodeBuddy CLI when it is not on `PATH`. */
  pathToCodebuddyCode?: string
  /**
   * Working directory for the CLI. Defaults to the process cwd; the Harness
   * sets its own process cwd, so most callers leave this unset.
   */
  cwd?: string
  /** Permission mode handed to the CLI. Defaults to `bypassPermissions`. */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'
  /** Model context window for every model, overriding the estimated value. */
  contextWindow?: number
  /** Max output tokens for every model, overriding the estimated value. */
  maxTokens?: number
}

export const Config: z<Config> = z.object({
  provider: z.string().description('Provider route (default codebuddy)'),
  model: z.string().description('Default model id (default codebuddy)'),
  pathToCodebuddyCode: z.string().description('Path to the CodeBuddy CLI'),
  cwd: z.string().description('Working directory for the CLI'),
  permissionMode: z.string().description('Permission mode passed to the CLI') as unknown as z<Config['permissionMode']>,
  contextWindow: z.number().description('Context window override for every model'),
  maxTokens: z.number().description('Max output tokens override for every model'),
})

export const name = 'codebuddy'
export const inject = ['llm']

/** Serialize CLI invocations: the CodeBuddy CLI owns a local control port. */
let chain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.then(() => undefined, () => undefined)
  return run
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

function mapInputModalities(model: CodeBuddyModel): Array<'text' | 'image'> {
  return [...model.input]
}

class CodeBuddyAdapter extends LlmAdapter {
  private models: CodeBuddyModel[] = [...FALLBACK_MODELS]
  private discovered = false

  constructor(private readonly config: Config) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'CodeBuddy' }
  }

  /** Adopt the CLI's own catalog once; discovery is expensive and stable. */
  private async refreshModels(): Promise<void> {
    if (this.discovered) return
    const provider = this.config.provider ?? PROVIDER_ID
    const bridge = createToolBridge([])
    const discovery = query({
      prompt: '',
      options: { mcpServers: { [bridge.server.name]: bridge.server } },
    })
    try {
      const supported: ModelInfo[] = await discovery.supportedModels()
      const mapped = modelsFromSdk(supported)
      if (mapped.length > 0) this.models = mapped
      this.discovered = true
    } catch {
      // Discovery is best-effort: the fallback catalog keeps the route usable
      // and the CLI reports the real model error on the first request.
    } finally {
      closeQueryTransport(discovery, `discover:${provider}`)
    }
  }

  private modelInfo(provider: string, model: CodeBuddyModel): LlmModelInfo {
    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: mapInputModalities(model),
    }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    await this.refreshModels()
    return this.models.map((model) => this.modelInfo(provider, model))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    await this.refreshModels()
    const resolved = resolveModel(this.models, model) ?? this.models.find((candidate) => candidate.id === model)
    const info = resolved ?? {
      id: model,
      name: model,
      reasoning: false,
      input: ['text'] as Array<'text' | 'image'>,
      contextWindow: this.config.contextWindow ?? 131_072,
      maxTokens: this.config.maxTokens ?? 8192,
    }
    return {
      ...this.modelInfo(provider, info),
      context: { contextWindow: this.config.contextWindow ?? info.contextWindow },
      defaultMaxTokens: this.config.maxTokens ?? info.maxTokens,
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const provider = options.provider || this.config.provider || PROVIDER_ID
    const model = options.model || this.config.model || FALLBACK_MODELS[0]!.id
    const cwd = this.config.cwd ?? process.cwd()
    const tools = options.tools ?? []
    const bridge = createToolBridge(tools)
    const prompt = lastUserText(options.messages) || '[continue]'
    // The last user turn is sent as the prompt; everything before it is the
    // history the CLI resumes from. Importing the last turn too and then
    // sending it again would duplicate it in the resumed conversation.
    const history = options.messages.filter((message) => message.role !== 'system')
    let lastUserIndex = -1
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index]?.role === 'user') { lastUserIndex = index; break }
    }
    const prior = lastUserIndex > 0 ? history.slice(0, lastUserIndex) : []
    const session = prior.length > 0 ? importSession(prior, cwd) : undefined

    let child: ReturnType<typeof query> | undefined
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })

    const source = await serialize(async () => {
      child = query({
        prompt,
        options: {
          cwd,
          abortController: controller,
          tools: [],
          permissionMode: this.config.permissionMode ?? 'bypassPermissions',
          includePartialMessages: true,
          systemPrompt: options.system,
          model,
          ...this.config.pathToCodebuddyCode === undefined
            ? {}
            : { pathToCodebuddyCode: this.config.pathToCodebuddyCode },
          ...session === undefined ? {} : { resume: session.sessionId },
          ...tools.length === 0 ? {} : { mcpServers: { [bridge.server.name]: bridge.server } },
        },
      })
      return child
    })

    try {
      yield* toStreamChunks(source as AsyncIterable<CodeBuddyMessage>, options.signal)
    } catch (error) {
      throw new LlmError(`CodeBuddy provider "${provider}" failed: ${errorMessage(error)}`, 'CODEBUDDY_ERROR', {
        cause: error instanceof Error ? error : undefined,
      })
    } finally {
      options.signal?.removeEventListener('abort', abort)
      endQuery(child, `stream:${provider}/${model}`)
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  const provider = config.provider ?? PROVIDER_ID
  ctx.llm.registerAdapter([provider], new CodeBuddyAdapter(config))
}
