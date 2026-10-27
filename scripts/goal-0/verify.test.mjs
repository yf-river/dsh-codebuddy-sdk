// 验证阻塞证据；这些断言通过不表示插件达到等价目标。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const artifact = name => new URL(`../../artifacts/goal-0/${name}`, import.meta.url)
const report = JSON.parse(readFileSync(artifact('report.json')))
const rawRequests = readFileSync(artifact('requests.json'))
const requests = JSON.parse(rawRequests)
const modelRequest = name => {
  assert.equal(report.cases[name].status, 'PASS')
  assert.equal(report.cases[name].modelRequests, 1)
  return requests.find(item => item.case === name && Array.isArray(item.body?.messages)).body
}
const native = modelRequest('native-dsh-history')
const plugin = modelRequest('original-plugin-history')
const minimal = modelRequest('public-sdk-minimal')
const contains = (value, text) => JSON.stringify(value).includes(text)
const chunks = report.cases['original-plugin-history'].result

test('隔离测试未调用真实模型；三个链路都返回受控响应', () => {
  assert.equal(report.realModelRequests, 0)
  assert.equal(report.network, 'independent namespace; loopback only')
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'fixture-ok'))
})
test('原生 DSH 传递系统提示词、历史 user、历史 assistant 和最终问题', () => {
  for (const marker of ['SYSTEM_SENTINEL', 'HISTORY_USER_SENTINEL', 'HISTORY_ASSISTANT_SENTINEL', 'FINAL_USER_SENTINEL']) {
    assert.ok(contains(native, marker), marker)
  }
  assert.deepEqual(native.messages.map(message => message.role), ['user', 'assistant', 'user'])
  assert.equal(native.max_tokens, 256)
})
test('当前插件遗漏 DSH 系统提示词及已有历史，模型收到 CodeBuddy 默认提示词', () => {
  for (const marker of ['SYSTEM_SENTINEL', 'HISTORY_USER_SENTINEL', 'HISTORY_ASSISTANT_SENTINEL']) {
    assert.equal(contains(plugin, marker), false, marker)
  }
  assert.ok(contains(plugin, 'FINAL_USER_SENTINEL'))
  assert.ok(contains(plugin.messages.find(message => message.role === 'system'), 'CodeBuddy'))
  assert.equal(plugin.max_tokens, 128000)
  assert.notEqual(plugin.max_tokens, native.max_tokens)
})
test('公开 systemPrompt 覆盖成功，但单轮输入仍有 user_query 包装', () => {
  assert.equal(minimal.messages.find(message => message.role === 'system').content,
    'SYSTEM_SENTINEL: follow only DSH instructions.')
  assert.ok(contains(minimal.messages.find(message => message.role === 'user'), '<user_query>'))
  assert.equal(contains(minimal, 'HISTORY_ASSISTANT_SENTINEL'), false)
})
test('SDK 和现有插件都能报告模拟端点 usage；不证明真实计费', () => {
  const usage = chunks.find(chunk => chunk.type === 'usage')?.usage
  assert.equal(usage.inputTokens, 11)
  assert.equal(usage.outputTokens, 3)
  const result = report.cases['public-sdk-minimal'].result.find(message => message.type === 'result')
  assert.equal(result.usage.input_tokens, 11)
  assert.equal(result.usage.output_tokens, 3)
})

writeFileSync(new URL('../../docs/goal-0-evidence.json', import.meta.url), JSON.stringify({
  date: '2026-10-26',
  status: 'BLOCKED',
  reason: 'No supported public SDK input for importing and replacing arbitrary DSH role history was found in the checked contract and official documentation.',
  node: report.node, sdk: report.sdk, cli: report.cli, dsh: '0.2.1-rc.3',
  realModelRequests: report.realModelRequests,
  requestsSha256: createHash('sha256').update(rawRequests).digest('hex'),
  native: { path: requests.find(item => item.case === 'native-dsh-history').path,
    roles: native.messages.map(message => message.role), maxTokens: native.max_tokens,
    systemPresent: contains(native, 'SYSTEM_SENTINEL'), historyPresent: contains(native, 'HISTORY_ASSISTANT_SENTINEL') },
  originalPlugin: { roles: plugin.messages.map(message => message.role), maxTokens: plugin.max_tokens,
    systemPresent: contains(plugin, 'SYSTEM_SENTINEL'), historyPresent: contains(plugin, 'HISTORY_ASSISTANT_SENTINEL'),
    codebuddyDefaultSystemPresent: contains(plugin.messages.find(message => message.role === 'system'), 'CodeBuddy') },
  minimalSdk: { roles: minimal.messages.map(message => message.role), maxTokens: minimal.max_tokens,
    systemOverrideExact: minimal.messages.find(message => message.role === 'system').content === 'SYSTEM_SENTINEL: follow only DSH instructions.',
    userQueryWrapperPresent: contains(minimal, '<user_query>'), historyPresent: false },
}, null, 2) + '\n')
