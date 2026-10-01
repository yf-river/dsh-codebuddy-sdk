/**
 * Mount smoke: the plugin registers its provider route and exposes the
 * adapter's model resolution without spawning a CLI.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Config, apply, inject, name } from '../src/index.ts'

function makeCtx() {
  const ctx = new Context()
  const registered = []
  ctx.provide('llm', {
    registerAdapter(providers, adapter) {
      registered.push({ providers, adapter })
    },
  })
  return { ctx, registered }
}

describe('dsh-codebuddy smoke', () => {
  it('declares its service dependency and plugin name', () => {
    assert.deepEqual(inject, ['llm'])
    assert.equal(name, 'codebuddy')
  })

  it('accepts an empty configuration', () => {
    const result = Config['~standard'].validate({})
    assert.equal(result.issues === undefined || result.issues.length === 0, true)
  })

  it('registers the adapter for the codebuddy route', () => {
    const { ctx, registered } = makeCtx()
    apply(ctx, {})
    assert.equal(registered.length, 1)
    assert.deepEqual(registered[0].providers, ['codebuddy'])
    assert.equal(registered[0].adapter.providerInfo('codebuddy').name, 'CodeBuddy')
  })
})
