import { unstable_v2_authenticate } from '@tencent-ai/agent-sdk'
import { randomUUID } from 'node:crypto'
import { failureOf } from './errors.js'
import { requestPolicy } from './request-policy.js'
import { CodeBuddyToolBridge } from './tool-bridge.js'
import type { WorkerRequest, WorkerReply } from './runtime.js'

const controller = new AbortController()
let started = false
const pendingSends = new Set<Promise<void>>()
function send(reply: WorkerReply): void {
  if (!process.connected) return
  let resolve: () => void
  const pending = new Promise<void>(done => { resolve = done })
  pendingSends.add(pending)
  const finish = () => { pendingSends.delete(pending); resolve!() }
  try { process.send!(reply, finish) } catch { finish(); controller.abort() }
}
process.on('disconnect', () => controller.abort())
process.on('message', async (packet: { type: string; request?: WorkerRequest }) => {
  if (packet.type === 'cancel') { controller.abort(); return }
  if (packet.type !== 'request' || started) return
  started = true
  try { await execute(packet.request!) }
  catch (error) { send({ type: 'failure', failure: failureOf(error) }) }
  finally {
    // 大段输出需要等待 IPC 写完，再关闭运行时进程。
    await Promise.all([...pendingSends])
    if (process.connected) process.disconnect()
    setImmediate(() => process.exit(0))
  }
})

async function execute(request: WorkerRequest): Promise<void> {
  // 仅通过公开认证接口沿用登录态；凭据不离开 worker，也不写入插件文件。
  const auth = await unstable_v2_authenticate({ executable: process.execPath, timeout: 2000,
    onAuthUrl: () => { throw new Error('请先使用 CodeBuddy 官方 CLI 登录') },
    env: { DISABLE_AUTOUPDATER: '1' } })
  controller.signal.throwIfAborted()
  const sdk = await import('@tencent-ai/codebuddy-code/server')
  const policy = requestPolicy(controller)
  const runtime = await sdk.start({ settingSources: [], sessionStore: new sdk.InMemorySessionStore(), httpProxy: policy })
  const id = randomUUID()
  let completed = false, generations = 0
  let subscriptionError: unknown
  const subscription = sdk.subscribe(id, event => {
    if (event.type === 'agent_event' && !completed) {
      // 公开 input 事件先于 SDK 的错误恢复；保留原始失败，交由 DSH 决定后续动作。
      const item = event.event.type === 'input' ? event.event.data as { role?: string; providerData?: { error?: unknown } } : undefined
      const error = event.event.type === 'error' ? event.event.data : item?.role === 'assistant' ? item.providerData?.error : undefined
      if (error) { subscriptionError ??= error; controller.abort() }
    }
    if (event.type === 'agent_sdk' && event.data.type === 'raw_model_stream_event') {
      const raw = event.data.data as import('./stream.js').ModelEvent
      if (raw.type === 'response_started' && ++generations > 1) {
        subscriptionError = new Error('SDK 在 DSH 请求之外继续生成'); controller.abort(); return
      }
      if (completed) return
      send({ type: 'message', message: raw })
      if (raw.type === 'response_done') {
        // DSH 消费单次模型响应；SDK 的工具/agent 循环属于收尾，不能阻塞完成确认。
        completed = true
        send({ type: 'complete' })
        controller.abort()
      }
    }
  }, { format: 'openai' })
  try {
    const bridge = new CodeBuddyToolBridge(request.tools)
    const mcp = request.tools.length ? await bridge.sdkServer(controller.signal) : undefined
    const result = await sdk.query(id, request.input, {
      model: request.model, cwd: request.cwd, systemPrompt: request.system || ' ', tools: [], disallowedTools: ['Read'],
      includePartialMessages: true, persistSession: false, permissionMode: 'default',
      auth: { accessToken: auth.userinfo.token },
      account: { uid: auth.userinfo.userId, ...(auth.userinfo.enterpriseId ? { enterpriseId: auth.userinfo.enterpriseId } : {}) },
      mcpServers: mcp ? { custom_tools: mcp } : {},
      canUseTool: async (name, _input) => {
        try { bridge.harnessName(name); return { behavior: 'deny', message: 'DSH executes this tool after the model response' } }
        catch { return { behavior: 'deny', message: 'Only DSH declared tools may execute' } }
      },
      abortController: controller,
      thinking: request.effort === 'off' ? { type: 'disabled' } : request.effort ? { type: 'adaptive' } : undefined,
      effort: request.effort === 'off' ? undefined : request.effort as 'low' | 'high' | 'max',
      settings: { autoCompactEnabled: false, env: {
        CODEBUDDY_DISABLE_SYSTEM_REMINDER_MD: '1', CODEBUDDY_PRE_MESSAGE_COMPACT: '0',
        ...(request.maxTokens === undefined ? {} : { CODEBUDDY_CODE_MAX_OUTPUT_TOKENS: String(request.maxTokens) }),
      } },
    })
    await subscription.drain()
    if (subscriptionError) {
      const failure = failureOf(subscriptionError)
      // 出站拦截引起的 SDK 取消提示不能覆盖拦截原因；原始上游状态优先。
      if (!policy.failure || failure.status !== undefined || failure.code !== 'CODEBUDDY_ERROR') throw failure
    }
    if (!completed && policy.failure) throw policy.failure
    if (subscriptionError) throw subscriptionError
    if (!completed) throw failureOf(result.errorMessage ?? `模型输出未完整结束：${result.stopReason}`)
  } finally { subscription(); await sdk.close(id); await runtime.stop() }
}
