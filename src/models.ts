/**
 * CodeBuddy model catalog and capability estimation.
 *
 * The CLI reports the available model ids but little else, so capacity is
 * estimated from the id with the same rules the Pi adapter uses.
 */

import type { ModelInfo } from '@tencent-ai/agent-sdk'

export interface CodeBuddyModel {
  id: string
  name: string
  reasoning: boolean
  input: Array<'text' | 'image'>
  contextWindow: number
  maxTokens: number
}

const DEFAULT_CONTEXT = 131_072
const DEFAULT_MAX_TOKENS = 8192

function detectThinking(id: string): boolean {
  return /claude|gemini|gpt-5|hy3|deepseek|glm/i.test(id)
}

function detectImages(id: string): boolean {
  return /claude|gemini|gpt/i.test(id)
}

function estimateContext(id: string): number {
  const lower = id.toLowerCase()
  if (lower.includes('gemini')) return 1_048_576
  if (lower.includes('claude') || lower.includes('gpt')) return 200_000
  return DEFAULT_CONTEXT
}

function estimateMaxTokens(id: string): number {
  return id.toLowerCase().includes('gpt') ? 16_384 : DEFAULT_MAX_TOKENS
}

export const FALLBACK_MODELS: CodeBuddyModel[] = [{
  id: 'hy3-preview-agent-ioa',
  name: 'Hunyuan 3 Preview',
  reasoning: true,
  input: ['text'],
  contextWindow: DEFAULT_CONTEXT,
  maxTokens: DEFAULT_MAX_TOKENS,
}]

export function modelsFromSdk(supported: readonly ModelInfo[]): CodeBuddyModel[] {
  return supported
    .map((model) => ({ id: model.value, name: model.displayName || model.value }))
    .filter((model) => model.id)
    .map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: detectThinking(model.id),
      input: detectImages(model.id) ? ['text', 'image'] as const : ['text'] as const,
      contextWindow: estimateContext(model.id),
      maxTokens: estimateMaxTokens(model.id),
    }))
}

export function resolveModel(
  models: readonly CodeBuddyModel[],
  input: string,
): CodeBuddyModel | undefined {
  const lower = input.toLowerCase()
  return models.find((model) => model.id.toLowerCase() === lower)
    ?? models.find((model) => model.id.toLowerCase().includes(lower))
}
