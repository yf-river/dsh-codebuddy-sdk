// 显式运行的三次 CodeBuddy 缓存验收；不执行模型工具、不修改已有会话。
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../dist/index.js'

if (!process.argv.includes('--run')) throw new Error('Live validation requires --run (at most 3 CodeBuddy model requests)')
const outputIndex = process.argv.indexOf('--out')
const output = resolve(outputIndex < 0 ? 'artifacts/cache-live' : process.argv[outputIndex + 1])
mkdirSync(output, { recursive: true, mode: 0o700 })
const reportFile = resolve(output, 'report.json')
if (existsSync(reportFile)) throw new Error('Output already exists; select a new --out directory')
const ctx = new Context()
let adapter
ctx.provide('llm', { registerAdapter: (_providers, value) => { adapter = value } })
apply(ctx, { cwd: output })
const tool = { name: 'read', description: 'Read a reference archive', parameters: { type: 'object', properties: {} } }
const text = (role, value) => ({ role, content: [{ type: 'text', text: value }] })
const prefix = Array.from({ length: 18000 }, (_, i) => `Reference record ${i}: this archive entry contains neutral background information.\n`).join('')
const result = 'Complete historical tool output, retained without a preview.\n'.repeat(1500) + '\nVerification code: 842617.'
const messages = [text('system', 'This is a cache validation. Do not call tools. Reply only with the verification code from the completed tool result.'),
  text('user', prefix + '\nRead the reference archive.'),
  { role: 'assistant', content: [{ type: 'tool-call', id: 'cache-validation-read', name: 'read', arguments: '{}' }] },
  { role: 'tool', source: { callId: 'cache-validation-read' }, content: [{ type: 'text', text: result }] },
  text('user', 'Reply with the verification code only.')]
const report = { provider: 'codebuddy', model: 'deepseek-v4.1-flash', effort: 'high', maxCalls: 3,
  maxOutputTokens: 1024, inputBytes: Buffer.byteLength(JSON.stringify(messages)), attempts: [] }
const save = () => writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
try {
  for (let i = 0; i < 3; i++) {
    const attempt = { startedAt: new Date().toISOString() }
    report.attempts.push(attempt); save()
    for await (const chunk of adapter.stream({ provider: report.provider, model: report.model, reasoningEffort: 'high',
      maxTokens: report.maxOutputTokens, tools: [tool], messages, signal: AbortSignal.timeout(180000) })) {
      if (chunk.type === 'usage') attempt.usage = chunk.usage
      if (chunk.type === 'finish') attempt.finish = chunk.reason
      if (chunk.type === 'text-delta') attempt.text = (attempt.text ?? '') + chunk.text
    }
    save(); console.log(JSON.stringify({ call: i + 1, ...attempt }))
    assert.equal(attempt.text?.trim(), '842617', 'The full historical tool result must remain readable')
    assert.equal(attempt.finish?.kind, 'stop')
    if (i === 1) messages.push(text('assistant', '842617'), text('user', 'Repeat the same verification code.'))
  }
  assert.ok(report.attempts[0].usage.inputTokens + report.attempts[0].usage.cacheReadTokens > 200000, 'Fixture must exceed 200K tokens')
  assert.ok(report.attempts[2].usage.cacheReadTokens > 200000, 'Third call must reuse a prefix beyond 200K')
  report.status = 'PASS'
} catch (error) {
  report.status = 'FAILED'; report.error = String(error); process.exitCode = 1
} finally { await adapter.dispose(); save() }
