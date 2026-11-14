import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCodeBuddyRetryPolicy } from '../src/retry-policy.ts'

test('默认策略把 NETWORK 纳入自动重试，同时保留临时错误集合', () => {
  const policy = resolveCodeBuddyRetryPolicy()
  assert.equal(policy.mode, 'normal')
  assert.ok(policy.retryableCodes.includes('NETWORK'))
  assert.ok(policy.retryableCodes.includes('TIMEOUT'))
  assert.ok(policy.retryableCodes.includes('TRANSPORT'))
})

test('显式 retryPolicy 不被默认策略改写', () => {
  const policy = resolveCodeBuddyRetryPolicy({ mode: 'normal', maxRetries: 1, retryableCodes: ['TIMEOUT'] })
  assert.deepEqual(policy.retryableCodes, ['TIMEOUT'])
  assert.equal(policy.maxRetries, 1)
})
