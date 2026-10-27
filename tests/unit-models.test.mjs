import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelsFromRaw, sameModel } from '../src/models.ts'

test('从官方完整目录读取容量、输出和推理档位，不按名称猜测', () => {
  const models = modelsFromRaw([{ id: 'deepseek-v4.1-flash', name: 'Flash', maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000, reasoning: { supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high' } },
    { id: 'disabled', disabled: true }])
  assert.deepEqual(models, [{ id: 'deepseek-v4.1-flash', name: 'Flash', contextWindow: 1_000_000,
    maxTokens: 128_000, efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'high' }])
  assert.equal(modelsFromRaw([{ id: 'unknown' }])[0].contextWindow, undefined)
  assert.deepEqual(modelsFromRaw([{ id: 'flash', onlyReasoning: true,
    reasoning: { canDisableThinking: true, supportedEfforts: ['low', 'high'] } }])[0].efforts, ['off', 'low', 'high'])
})
test('接受企业部署后缀并拒绝其他模型/版本的替换', () => {
  assert.equal(sameModel('deepseek-v4.1-flash', 'deepseek-v4.1-flash-ioa'), true)
  assert.equal(sameModel('deepseek-v4.1-flash', 'deepseek-v4-pro-ioa'), false)
  assert.equal(sameModel('deepseek-v4.1-flash', 'hy3'), false)
})
