import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'

/**
 * DSH's transient defaults omit NETWORK, but CodeBuddy reports a cut model
 * stream as NETWORK; include it unless the route supplies an explicit policy.
 */
export function resolveCodeBuddyRetryPolicy(config?: RetryPolicyConfig): ResolvedRetryPolicy {
  const resolved = resolveRetryPolicy(config, 'codebuddy: retryPolicy')
  if (config !== undefined || resolved.mode !== 'normal' || resolved.retryableCodes.includes('NETWORK')) return resolved
  return { ...resolved, retryableCodes: [...resolved.retryableCodes, 'NETWORK'] }
}
