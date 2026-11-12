import type { ToolSchema } from '@deepseek-ai/dsh-llm'

export interface ToolPolicy {
  /** Patterns allowed to reach the model; omitted or empty means every tool. */
  allow?: readonly string[]
  /** Patterns removed after allow; deny wins over allow. `*` is the only wildcard. */
  deny?: readonly string[]
}

function patternToRegExp(pattern: string): RegExp {
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`)
}

export function matchesToolPattern(name: string, pattern: string): boolean {
  return patternToRegExp(pattern).test(name)
}

/** Apply the profile's tool policy before the tools reach CodeBuddy or the DSH bridge. */
export function selectTools(tools: readonly ToolSchema[], policy?: ToolPolicy): ToolSchema[] {
  if (!policy) return [...tools]
  const allow = policy.allow?.length ? policy.allow : ['*']
  const allowMatchers = allow.map(patternToRegExp)
  const denyMatchers = (policy.deny ?? []).map(patternToRegExp)
  return tools.filter(tool => allowMatchers.some(matcher => matcher.test(tool.name)) && !denyMatchers.some(matcher => matcher.test(tool.name)))
}
