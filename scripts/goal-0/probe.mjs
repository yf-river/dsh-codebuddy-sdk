// 只在独立网络命名空间中运行；本地端点使用固定响应，不调用真实模型。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readlinkSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = resolve(root, 'artifacts/goal-0')
mkdirSync(output, { recursive: true })

if (!process.argv.includes('--isolated')) {
  const baseline = resolve(output, 'baseline-src')
  mkdirSync(baseline, { recursive: true })
  for (const file of ['index.ts', 'convert.ts', 'models.ts', 'stream.ts', 'tool-bridge.ts', 'teardown.ts', 'zod-shape.ts']) {
    const source = spawnSync('git', ['show', `14ac92ebc73c2a2576ce5c6f0e8f9453acbf66b9:src/${file}`], { cwd: root })
    assert.equal(source.status, 0, `Cannot read original baseline ${file}`)
    writeFileSync(resolve(baseline, file), source.stdout)
  }
  const home = mkdtempSync(resolve(tmpdir(), 'dsh-codebuddy-goal-0-'))
  const result = spawnSync('unshare', ['-n', '--', 'sh', '-c',
    'ip link set lo up && exec "$@"', 'sh', process.execPath,
    '--import', 'tsx', fileURLToPath(import.meta.url), '--isolated'], {
    cwd: root,
    // 白名单环境避免继承真实凭据、代理或用户配置。
    env: {
      PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home, XDG_CONFIG_HOME: `${home}/config`, XDG_CACHE_HOME: `${home}/cache`,
      CODEBUDDY_CONFIG_DIR: `${home}/codebuddy`, DISABLE_AUTOUPDATER: '1',
      CODEBUDDY_API_KEY: 'local-fixture-key', NO_PROXY: '127.0.0.1,localhost',
      DSH_DEEPSEEK_ADAPTER: process.env.DSH_DEEPSEEK_ADAPTER,
      GOAL_0_HOST_NET: readlinkSync('/proc/self/ns/net'),
    },
    encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  })
  writeFileSync(resolve(output, 'run.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.error) console.error(result.error.message)
  process.exit(result.status ?? 1)
}

assert.notEqual(readlinkSync('/proc/self/ns/net'), process.env.GOAL_0_HOST_NET)
assert.ok(Object.values(networkInterfaces()).flat().every(address => address.internal))
const report = {
  node: process.version,
  sdk: JSON.parse(readFileSync(resolve(root, 'node_modules/@tencent-ai/agent-sdk/package.json'))).version,
  cli: JSON.parse(readFileSync(resolve(root, 'node_modules/@tencent-ai/agent-sdk/cli/package.json'))).version,
  network: 'independent namespace; loopback only',
  realModelRequests: 0,
  cases: {},
}
const requests = []
let activeCase
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString()
  let body
  try { body = JSON.parse(raw) } catch { body = raw }
  // 不收集认证头；这里唯一的 key 是上面生成的虚拟 key。
  requests.push({ case: activeCase, method: req.method, path: req.url, body })
  if (req.method === 'POST' && Array.isArray(body.messages)) {
    if (req.url.includes('chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const delta of [{ role: 'assistant', content: '' }, { content: 'fixture-ok' }]) {
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl-local', object: 'chat.completion.chunk',
          created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-local', object: 'chat.completion.chunk',
        created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    const message = { id: 'msg_local_fixture', type: 'message', role: 'assistant',
      model: body.model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of [
        { type: 'message_start', message },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture-ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'fixture-ok' }], stop_reason: 'end_turn' }))
    }
  } else {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [], models: [] }))
  }
})
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const endpoint = `http://127.0.0.1:${server.address().port}`
process.env.CODEBUDDY_BASE_URL = endpoint
const cwd = resolve(process.env.HOME, 'project')
mkdirSync(cwd, { recursive: true })
process.chdir(cwd)
const model = 'deepseek-v4.1-flash'
const text = (role, value, id) => ({ id, role, content: [{ type: 'text', text: value }],
  source: role === 'assistant' ? { kind: 'model', provider: 'deepseek', model } : { kind: 'user' } })
const input = {
  provider: 'deepseek', model, sessionId: 'goal-0-history', maxTokens: 256, reasoningEffort: 'off',
  messages: [
    text('system', 'SYSTEM_SENTINEL: follow only DSH instructions.', 's1'),
    text('user', 'HISTORY_USER_SENTINEL: remember value 42.', 'u1'),
    text('assistant', 'HISTORY_ASSISTANT_SENTINEL: value recorded.', 'a1'),
    text('user', 'FINAL_USER_SENTINEL: what value did I give?', 'u2'),
  ], tools: [],
}
writeFileSync(resolve(output, 'input.json'), JSON.stringify(input, null, 2))
const { query } = await import('@tencent-ai/agent-sdk')
const { apply } = await import(pathToFileURL(resolve(output, 'baseline-src/index.ts')).href)
const { Context } = await import('@deepseek-ai/cordis')

async function runCase(name, fn) {
  activeCase = name
  try {
    report.cases[name] = { status: 'PASS', result: await fn() }
  } catch (error) {
    report.cases[name] = { status: 'FAILED', error: String(error.stack ?? error) }
  }
  console.log(`${name}: ${report.cases[name].status}`)
}
try {
  await runCase('native-dsh-history', async () => {
    const nativePath = process.env.DSH_DEEPSEEK_ADAPTER
    assert.ok(nativePath, 'Set DSH_DEEPSEEK_ADAPTER to the installed matching adapter lib/index.js')
    const { DeepSeekAdapter, resolveAdapterOptions } = await import(pathToFileURL(nativePath).href)
    const adapter = new DeepSeekAdapter({
      options: () => resolveAdapterOptions({ baseURL: endpoint, maxTokens: 256, reasoningEffort: 'off', retryPolicy: { mode: 'normal', maxRetries: 0 } }),
      resolveAuth: async () => ({ headers: { authorization: 'Bearer local-fixture-key' } }),
      resolveUserId: () => 'goal-0-local',
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    })
    const chunks = []
    for await (const chunk of adapter.stream({ ...input, signal: AbortSignal.timeout(15_000) })) chunks.push(chunk)
    return chunks
  })
  await runCase('original-plugin-history', async () => {
    let adapter
    const ctx = new Context()
    ctx.provide('llm', { registerAdapter: (_providers, value) => { adapter = value } })
    apply(ctx, { cwd, pathToCodebuddyCode: resolve(root, 'node_modules/@tencent-ai/agent-sdk/cli/bin/codebuddy') })
    const chunks = []
    try {
      for await (const chunk of adapter.stream({ ...input, provider: 'codebuddy', signal: AbortSignal.timeout(25_000) })) chunks.push(chunk)
      return chunks
    } finally { await adapter.dispose() }
  })
  await runCase('public-sdk-minimal', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 25_000)
    const messages = []
    const q = query({ prompt: 'FINAL_USER_SENTINEL: what value did I give?', options: {
      cwd, executable: process.execPath, tools: [], strictMcpConfig: true, settingSources: [],
      systemPrompt: input.messages[0].content[0].text, model, thinking: { type: 'disabled' },
      maxTurns: 1, persistSession: false, abortController: controller,
      stderr: data => writeFileSync(resolve(output, 'sdk-stderr.log'), data, { flag: 'a' }),
    } })
    try { for await (const message of q) messages.push(message) }
    finally { clearTimeout(timer); await q.return() }
    return messages
  })
} finally {
  server.closeAllConnections()
  await new Promise(resolveClose => server.close(resolveClose))
  writeFileSync(resolve(output, 'requests.json'), JSON.stringify(requests, null, 2))
  for (const [name, item] of Object.entries(report.cases)) {
    item.modelRequests = requests.filter(request => request.case === name && Array.isArray(request.body?.messages)).length
    if (!item.modelRequests && item.status === 'PASS') {
      item.status = 'FAILED'
      item.error = 'No model request was captured; this case provides no wire evidence.'
    }
  }
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
}
// 所有 query 关闭、结果写入后，结束这个独立的探针进程。
process.exit(Object.values(report.cases).some(item => item.status !== 'PASS') ? 1 : 0)
