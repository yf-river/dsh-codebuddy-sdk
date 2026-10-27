// 用户明确授权后才运行：最多三个 CodeBuddy 尝试、三个原生通道尝试，共六次。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

if (!process.argv.includes('--run')) throw new Error('真实调用需要显式 --run；默认不会消费额度')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'artifacts/live')
mkdirSync(output, { recursive: true, mode: 0o700 })
const ledgerPath = resolve(output, 'budget.json')
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath)) : { codebuddy: 0, native: 0, attempts: [] }
if (ledger.codebuddy >= 3) throw new Error('CodeBuddy 通道的测试预算已用完；不会追加调用或覆盖原验证报告')
function reserve(channel, name) {
  if (ledger[channel] >= 3 || ledger.codebuddy + ledger.native >= 6) throw new Error('本次会话的真实测试预算已用完')
  ledger[channel]++
  ledger.attempts.push({ channel, name, time: new Date().toISOString() })
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600 })
}
const home = mkdtempSync(resolve(tmpdir(), 'dsh-codebuddy-live-'))
const cwd = resolve(home, 'workspace')
mkdirSync(cwd)
const checks = []
const question = 'Python 表达式 sum(i*i for i in range(5)) 的值是多少？不要使用工具，只回复一个整数。'
async function headless(channel) {
  const profile = resolve(home, 'profiles', channel)
  mkdirSync(resolve(profile, 'node_modules'), { recursive: true })
  symlinkSync(root, resolve(profile, 'node_modules/dsh-codebuddy-sdk'), 'dir')
  writeFileSync(resolve(profile, 'package.json'), JSON.stringify({ private: true, type: 'module', dsh: { profile: { bundles: [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', ...(channel === 'codebuddy' ? ['dsh-codebuddy-sdk'] : []),
  ] } } }))
  const patch = channel === 'codebuddy'
    ? '- id: agent-default-model\n  config:\n    provider: codebuddy\n    model: deepseek-v4.1-flash\n    reasoningEffort: high\n- id: codebuddy\n  config:\n    maxTokens: 256\n'
    : '- id: credentials\n  disabled: false\n- id: authorization\n  disabled: false\n- id: deepseek-account\n  disabled: false\n- id: agent-default-model\n  config:\n    provider: deepseek-account\n    model: deepseek-flash\n    reasoningEffort: high\n- id: llm-deepseek-account\n  config:\n    maxTokens: 256\n    modelOverrides:\n      deepseek-flash:\n        maxTokens: 256\n    retryPolicy:\n      mode: normal\n      maxRetries: 0\n'
  writeFileSync(resolve(profile, 'cordis.patch.yml'), patch)
  reserve(channel, 'DSH headless short arithmetic')
  const result = await new Promise(resolveRun => {
    const child = spawn(process.execPath, ['/data/ida/tools/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '--profile', channel, '--json', question], {
      cwd, env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(home, 'agents'), DSH_TELEMETRY_DISABLED: '1',
        DISABLE_AUTOUPDATER: '1', CODEBUDDY_MAX_RETRIES: '0' },
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
    child.on('close', code => { clearTimeout(timer); resolveRun({ code, stdout, stderr }) })
  })
  const events = result.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  const answer = events.find(event => event.type === 'final')?.text ?? ''
  const usage = events.filter(event => event.type === 'status' && event.phase === 'step_end').map(event => event.usage)
  const failure = events.find(event => event.type === 'error')?.error
    ?? events.find(event => event.type === 'status' && event.phase === 'turn_end' && event.reason?.kind === 'error')?.reason.error
  const summary = { channel, entry: 'DSH headless', code: result.code, answer, usage,
    ...(failure ? { failure: { code: failure.code, message: failure.message } } : {}) }
  checks.push(summary)
  writeFileSync(resolve(output, `${channel}-headless.json`), JSON.stringify(summary, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(summary))
  assert.equal(result.code, 0, `${channel} DSH request failed`)
  assert.match(answer.trim(), /^30[。.]?$/)
  assert.ok(usage.some(item => item?.inputTokens > 0 && item.outputTokens > 0))
}
async function codebuddyRpc() {
  const profile = resolve(home, 'profiles/codebuddy-rpc')
  mkdirSync(resolve(profile, 'node_modules'), { recursive: true })
  symlinkSync(root, resolve(profile, 'node_modules/dsh-codebuddy-sdk'), 'dir')
  writeFileSync(resolve(profile, 'package.json'), JSON.stringify({ private: true, type: 'module',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app', 'dsh-codebuddy-sdk'] } } }))
  const { startDsh } = await import('./dsh-client.mjs')
  const client = startDsh({ home, cwd, profile: 'codebuddy-rpc', env: { DISABLE_AUTOUPDATER: '1', CODEBUDDY_MAX_RETRIES: '0' } })
  try {
    await client.request('initialize', { cwd, provider: 'codebuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high', maxTokens: 256 })
    const sessionId = `live-${randomUUID()}`
    for (const [index, prompt] of [question, '把刚才表达式的 range(5) 改为 range(3)，结果是多少？不要用工具，只回复一个整数。'].entries()) {
      reserve('codebuddy', `real DSH SDK entry turn ${index + 1}`)
      const events = await client.turn(sessionId, prompt)
      const replies = events.filter(event => event.type === 'assistant/message').map(event => event.data)
      const answer = replies.flatMap(reply => reply.message.content.filter(block => block.type === 'text').map(block => block.text)).join('')
      const summary = { channel: 'codebuddy', entry: 'DSH SDK app', turn: index + 1, answer,
        usage: replies.map(reply => reply.usage), finish: events.find(event => event.type === 'turn/end')?.data.reason,
        models: replies.map(reply => ({ requested: reply.message.source.model, replayState: reply.message.source.replayState })) }
      checks.push(summary)
      writeFileSync(resolve(output, `dsh-sdk-turn-${index + 1}.json`), JSON.stringify(summary, null, 2), { mode: 0o600 })
      console.log(JSON.stringify(summary))
      assert.equal(summary.finish?.kind, 'completed')
      assert.match(answer.trim(), index === 0 ? /^30[。.]?$/ : /^5[。.]?$/)
      assert.ok(summary.usage.some(usage => usage?.inputTokens > 0 && usage.outputTokens > 0))
    }
  } finally { await client.close() }
}
try {
  if (process.argv.includes('--remaining')) {
    await codebuddyRpc()
    if (existsSync('/root/.dsh/.credentials.yaml')) {
      copyFileSync('/root/.dsh/.credentials.yaml', resolve(home, '.credentials.yaml'))
      chmodSync(resolve(home, '.credentials.yaml'), 0o600)
      await headless('native')
    }
  } else {
  await headless('codebuddy')
  const originalCredentials = '/root/.dsh/.credentials.yaml'
  if (existsSync(originalCredentials)) {
    copyFileSync(originalCredentials, resolve(home, '.credentials.yaml'))
    chmodSync(resolve(home, '.credentials.yaml'), 0o600)
    await headless('native')
  } else checks.push({ channel: 'native', status: 'not tested', reason: 'No existing native DSH account credential' })

  const { Context } = await import('@deepseek-ai/cordis')
  const { BlockAssembler } = await import('@deepseek-ai/dsh-llm')
  const { apply } = await import('../src/index.ts')
  const ctx = new Context()
  let adapter
  ctx.provide('llm', { registerAdapter: (_providers, value) => { adapter = value } })
  apply(ctx, { cwd, maxTokens: 256 })
  const sessionId = `live-${randomUUID()}`
  const text = (role, value) => ({ role, content: [{ type: 'text', text: value }], source: { kind: 'user' } })
  const messages = [text('system', '按用户要求直接回答，不使用工具。'), text('user', '记住数字37。只回复OK。')]
  try {
    for (const turn of [1, 2]) {
      reserve('codebuddy', `SDK memory turn ${turn}`)
      const chunks = []
      for await (const chunk of adapter.stream({ provider: 'codebuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high',
        sessionId, messages, maxTokens: 256, signal: AbortSignal.timeout(45_000) })) {
        chunks.push(chunk)
        if (chunk.type === 'finish') break
      }
      const assembler = new BlockAssembler()
      chunks.forEach(chunk => assembler.push(chunk))
      const blocks = assembler.blocks()
      const answer = blocks.filter(block => block.type === 'text').map(block => block.text).join('')
      const summary = { channel: 'codebuddy', entry: 'SDK adapter', turn, answer,
        usage: chunks.filter(chunk => chunk.type === 'usage').map(chunk => chunk.usage),
        finish: chunks.find(chunk => chunk.type === 'finish')?.reason.kind }
      checks.push(summary)
      writeFileSync(resolve(output, `sdk-turn-${turn}.json`), JSON.stringify(summary, null, 2), { mode: 0o600 })
      console.log(JSON.stringify(summary))
      assert.equal(summary.finish, 'stop')
      assert.match(answer.trim(), turn === 1 ? /^OK[。.!！]?$/i : /^42[。.]?$/)
      messages.push(assembler.message({ provider: 'codebuddy', model: 'deepseek-v4.1-flash' }))
      if (turn === 1) messages.push(text('user', '刚才的数字加5是多少？只回复数字。'))
    }
  } finally { await adapter.dispose() }
  }
} catch (error) {
  checks.push({ status: 'FAILED', errorName: error.name, code: error.code, message: error.message })
  process.exitCode = 1
} finally {
  // 只删除本次复制的临时凭据，原始凭据不改动。
  rmSync(resolve(home, '.credentials.yaml'), { force: true })
  writeFileSync(resolve(output, 'report.json'), JSON.stringify({ maxOutputTokens: 256, attemptedCalls: ledger, checks }, null, 2), { mode: 0o600 })
}
