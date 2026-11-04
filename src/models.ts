import type { RawLanguageModel } from '@tencent-ai/agent-sdk'

function canonicalModelId(id: string): string {
  const base = id.replace(/-ioa$/, '')
  // Hy4 账号目录使用 hy4std，实际响应使用 hy4-ioa。
  return base === 'hy4std' ? 'hy4' : base
}

export function sameModel(requested: string, reported: string): boolean {
  return canonicalModelId(requested) === canonicalModelId(reported)
}

export interface CodeBuddyModel {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  efforts?: string[]
  defaultEffort?: string
  supportsImages: boolean
  maxImageCount?: number
}

export function modelsFromRaw(models: readonly RawLanguageModel[]): CodeBuddyModel[] {
  return models.filter(model => model.id && !model.disabled).map(model => {
    // 账号目录的新字段已返回，锁定 SDK 的类型声明尚未包含它。
    const reasoning = model.reasoning as (RawLanguageModel['reasoning'] & { canDisableThinking?: boolean }) | undefined
    return {
    id: model.id, name: model.name ?? model.id,
    contextWindow: model.contextWindow?.defaultLength ?? model.maxInputTokens,
    maxTokens: model.maxOutputTokens,
    supportsImages: model.supportsImages === true && model.disabledMultimodal !== true,
    ...(model.maxImageCount > 0 ? { maxImageCount: model.maxImageCount } : {}),
    efforts: [...new Set([...(!model.onlyReasoning || reasoning?.canDisableThinking ? ['off'] : []), ...(model.reasoning?.supportedEfforts
      ?? (model.reasoning?.effort ? [model.reasoning.effort] : []))])],
    defaultEffort: model.reasoning?.defaultEffort ?? model.reasoning?.effort,
    }
  })
}
