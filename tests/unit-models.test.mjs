import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FALLBACK_MODELS, modelsFromSdk, resolveModel } from '../src/models.ts'

describe('modelsFromSdk', () => {
  it('maps ids and names and estimates capability from the id', () => {
    const models = modelsFromSdk([
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet', description: '' },
      { id: 'hy3-preview-agent-ioa', name: 'Hunyuan' },
    ])
    assert.equal(models[0].contextWindow, 200_000)
    assert.equal(models[0].input.includes('image'), true)
    assert.equal(models[1].contextWindow, 131_072)
    assert.equal(models[1].input.includes('image'), false)
  })

  it('drops entries without an id', () => {
    assert.deepEqual(modelsFromSdk([{ value: '', displayName: 'no id', description: '' }]), [])
  })
})

describe('resolveModel', () => {
  it('prefers an exact match then a substring', () => {
    const models = [
      { ...FALLBACK_MODELS[0], id: 'gpt-5' },
      { ...FALLBACK_MODELS[0], id: 'gpt-5-mini' },
    ]
    assert.equal(resolveModel(models, 'gpt-5').id, 'gpt-5')
    assert.equal(resolveModel(models, 'MINI').id, 'gpt-5-mini')
  })
})
