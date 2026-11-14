import { fork, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { llmError, type Failure } from './errors.js'
import type { ModelEvent } from './stream.js'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

export interface WorkerRequest { model: string; cwd: string; system: string; input: unknown[]; tools: readonly ToolSchema[]; maxTokens?: number; effort?: string; search?: { query: string }; /** Per-request spill threshold, applied inside the worker before querying. */ toolResultThresholdKb?: number }
export type WorkerReply = { type: 'message'; message: ModelEvent } | { type: 'complete' } | { type: 'failure'; failure: Failure } | { type: 'warm-ready' }
export interface WorkerCleanup { kind: 'normal' | 'forced'; durationMs: number; reason?: string }

const GRACE_MS = 5000
const REAP_MS = 1000
// 归属记录保留到实际 close；超时返回不等于宣称无法确认的进程已退出。
const owned = new Set<ChildProcess>()

/** How long a warm worker waits for its request before it is reaped. */
const WARM_TTL_MS = 2 * 60 * 1000
/** Upper bound on warm workers across every key. */
const WARM_CAP = 10

interface WarmSlot { worker: ChildProcess; ready: boolean; timer?: ReturnType<typeof setTimeout> }

const warmSlots = new Map<string, WarmSlot[]>()
const inflight = new Map<string, number>()

const warmKey = (request: WorkerRequest): string => request.model + '\u0000' + request.cwd

function bumpInflight(key: string, delta: number): void {
  const next = Math.max(0, (inflight.get(key) ?? 0) + delta)
  if (next === 0) inflight.delete(key)
  else inflight.set(key, next)
}

function dropSlot(key: string, slot: WarmSlot, kill: boolean): void {
  const list = warmSlots.get(key)
  if (list !== undefined) {
    const index = list.indexOf(slot)
    if (index >= 0) list.splice(index, 1)
    if (list.length === 0) warmSlots.delete(key)
  }
  if (slot.timer !== undefined) clearTimeout(slot.timer)
  slot.worker.removeAllListeners()
  if (kill) { try { slot.worker.kill('SIGKILL') } catch {} }
  owned.delete(slot.worker)
}

/**
 * Fork a worker in the environment every CodeBuddy request needs.
 *
 * A warm spare skips the stderr pipe: nobody reads it before the request
 * arrives, and an open pipe keeps the host process alive past its work.
 */
function forkWorker(request: WorkerRequest, warm = false): ChildProcess {
  return fork(fileURLToPath(new URL('./worker.js', import.meta.url)), [], {
    cwd: request.cwd, execPath: process.execPath, execArgv: [], detached: true,
    stdio: ['ignore', 'ignore', warm ? 'ignore' : 'pipe', 'ipc'],
    env: { ...process.env, DISABLE_AUTOUPDATER: '1', CODEBUDDY_DISABLE_AUTO_MEMORY: '1', CODEBUDDY_CODE_DISABLE_AUTO_MEMORY: '1',
      CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1', CODEBUDDY_DISABLE_SYSTEM_REMINDER_MD: '1', CODEBUDDY_PRE_MESSAGE_COMPACT: '0',
      // A silent model stream should fail fast (3 minutes) instead of waiting for the 10-minute upstream idle cut.
      CODEBUDDY_STREAM_TIMEOUT_MS: '180000', CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS: '180000',
      CODEBUDDY_RECOVERY_FIRST_TOKEN_TIMEOUT_MS: '180000',
      CODEBUDDY_MAX_RETRIES: '0', CODEBUDDY_MODEL_401_MAX_RETRIES: '0', CODEBUDDY_RETRY_WATCHDOG: '0' },
  })
}

/** Take an already-warm worker for this key, or undefined when none is ready. */
function takeWarm(request: WorkerRequest): ChildProcess | undefined {
  const key = warmKey(request)
  const list = warmSlots.get(key)
  const index = list?.findIndex(slot => slot.ready) ?? -1
  if (list === undefined || index < 0) return undefined
  const [slot] = list.splice(index, 1)
  if (list.length === 0) warmSlots.delete(key)
  if (slot.timer !== undefined) clearTimeout(slot.timer)
  // The request owns these handlers now; the slot's own listeners must not see it.
  slot.worker.removeAllListeners()
  slot.worker.stderr?.removeAllListeners()
  // A spare is unref'd while idle; once it carries a request it must hold the
  // host open exactly like a cold fork does.
  slot.worker.ref()
  ;(slot.worker as unknown as { channel?: { ref?: () => void } }).channel?.ref?.()
  return slot.worker
}

/**
 * Keep one warm worker per in-flight request of this key, capped globally.
 *
 * A warm worker is still single-use — it serves exactly one request and exits —
 * so state isolation is unchanged from the cold path; the only difference is
 * that authentication and runtime startup happened while the previous request
 * was still streaming.
 */
function ensureWarm(request: WorkerRequest): void {
  const key = warmKey(request)
  const list = warmSlots.get(key) ?? []
  const target = Math.min(WARM_CAP, inflight.get(key) ?? 0)
  if (list.length >= target) return
  const worker = forkWorker(request, true)
  // A spare must never hold the host process open; the IPC channel is a handle
  // of its own, so unref it alongside the child.
  worker.unref()
  ;(worker as unknown as { channel?: { unref?: () => void } }).channel?.unref?.()
  owned.add(worker)
  const slot: WarmSlot = { worker, ready: false }
  list.push(slot)
  warmSlots.set(key, list)
  worker.on('message', (reply: WorkerReply) => {
    if (reply.type === 'warm-ready') { slot.ready = true; return }
    if (reply.type === 'failure') dropSlot(key, slot, true)
  })
  worker.on('error', () => { dropSlot(key, slot, true) })
  worker.on('exit', () => { dropSlot(key, slot, false) })
  slot.timer = setTimeout(() => { dropSlot(key, slot, true) }, WARM_TTL_MS)
  slot.timer.unref()
  worker.send({ type: 'warm' }, () => {})
}

process.once('exit', () => {
  for (const list of warmSlots.values()) {
    for (const slot of list) { try { slot.worker.kill('SIGKILL') } catch {} }
  }
})

export function runWorker(request: WorkerRequest, signal?: AbortSignal) {
  // DSH 管理历史工具结果；SDK 的落盘预览包含临时会话路径，会改写重放前缀。
  // 整份输入的 JSON 字节数覆盖任一结果的 UTF-8 字节数，阈值随本次输入计算。
  const toolResultThresholdKb = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(request.input), 'utf8') / 1024))
  const key = warmKey(request)
  bumpInflight(key, 1)
  const worker = takeWarm(request) ?? forkWorker(request)
  owned.add(worker)
  const queue: ModelEvent[] = []
  let wake: (() => void) | undefined, failure: Error | undefined
  let settled = false, complete = false, exited = false, forced = false
  let cleanupStarted: number | undefined, cleanupReason: string | undefined
  let resolveDone: () => void
  const done = new Promise<void>(resolve => { resolveDone = resolve })
  let deadline: ReturnType<typeof setTimeout> | undefined, reapTimer: ReturnType<typeof setTimeout> | undefined
  let reapEnds = 0
  const groupAlive = (): boolean | undefined => {
    if (!worker.pid) return undefined
    if (process.platform !== 'linux') {
      try { process.kill(-worker.pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : undefined }
    }
    try {
      // 只判断本次创建的进程组，不按名称寻找或操作其他进程。
      for (const pid of readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue
        try {
          const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')
          if (Number(fields[2]) === worker.pid && !['Z', 'X'].includes(fields[0])) return true
        } catch {}
      }
      return false
    } catch { return undefined }
  }
  const notify = () => { wake?.(); wake = undefined }
  const detach = () => {
    try { if (worker.connected) worker.disconnect() } catch {}
    worker.stderr?.destroy()
    worker.unref()
  }
  const settle = () => {
    if (settled) return
    settled = true
    bumpInflight(key, -1)
    if (deadline) clearTimeout(deadline)
    if (reapTimer) clearTimeout(reapTimer)
    signal?.removeEventListener('abort', stop)
    notify(); resolveDone!()
  }
  const checkReaped = () => {
    if (settled) return
    if (reapTimer) clearTimeout(reapTimer)
    if (exited && groupAlive() === false) { owned.delete(worker); detach(); settle(); return }
    if (performance.now() >= reapEnds) {
      failure = new LlmError(`无法确认本次 CodeBuddy 进程组已退出（pid=${worker.pid ?? 'unknown'}）`, 'CODEBUDDY_CLEANUP_TIMEOUT')
      detach(); settle(); return
    }
    reapTimer = setTimeout(checkReaped, Math.min(20, Math.max(1, reapEnds - performance.now())))
    reapTimer.unref()
  }
  const force = () => {
    if (settled) return
    forced = true
    cleanupReason ??= complete ? 'cleanup-timeout' : 'finalization-timeout'
    if (!complete && !failure && !signal?.aborted) failure = new LlmError('SDK 未及时报告本次请求完成', 'CODEBUDDY_FINALIZATION_TIMEOUT')
    // 子进程拥有独立进程组；不按名称扫描，也不操作其他 DSH 的进程。
    try { if (worker.pid) process.kill(-worker.pid, 'SIGKILL') } catch {}
    reapEnds = performance.now() + REAP_MS
    checkReaped()
  }
  const arm = (reset = false) => {
    cleanupStarted ??= performance.now()
    if (reset && deadline) { clearTimeout(deadline); deadline = undefined }
    if (!deadline) { deadline = setTimeout(force, GRACE_MS); deadline.unref() }
  }
  const stop = () => {
    if (settled) return
    if (worker.connected) worker.send({ type: 'cancel' }, () => {})
    arm()
  }
  worker.stderr?.on('data', () => {}) // SDK 日志可能含账户信息，不转发或保存；预热进程不接 stderr 管道。
  worker.on('message', (reply: WorkerReply) => {
    if (settled) return
    if (reply.type === 'message') {
      queue.push(reply.message)
      if (reply.message.type === 'response_done' && !complete && !request.search) arm()
    } else if (reply.type === 'complete') {
      if (!complete) { complete = true; arm(!signal?.aborted && !failure) }
    } else if (complete) {
      cleanupReason ??= 'cleanup-error'
      stop()
    } else if (reply.type === 'failure') { failure ??= llmError(reply.failure); stop() }
    notify()
  })
  worker.on('error', error => { failure ??= error; stop(); notify() })
  worker.on('exit', () => {
    exited = true
    if (forced) checkReaped()
  })
  worker.on('close', code => {
    exited = true
    if (settled) { owned.delete(worker); return }
    if (!settled && ((!complete || code !== 0) && !forced) && !failure) failure = new Error(`CodeBuddy worker 提前退出（${code}）`)
    if (forced) checkReaped()
    else if (worker.pid && groupAlive() === true) arm()
    else { owned.delete(worker); settle() }
  })
  signal?.addEventListener('abort', stop, { once: true })
  worker.send({
    type: 'request',
    request: request.search ? request : { ...request, toolResultThresholdKb },
  }, error => { if (error && !settled) { failure ??= error; stop(); notify() } })
  // This request consumed a spare (or went cold); warm the next one behind it.
  // Web search is an occasional one-shot path with its own tool whitelist, so it
  // keeps the cold start instead of holding a spare.
  if (!request.search) ensureWarm(request)
  if (signal?.aborted) stop()
  return {
    done, stop,
    async *messages(): AsyncGenerator<ModelEvent> {
      try {
        while (true) {
          if (queue.length) { yield queue.shift()!; continue }
          if (failure) throw failure
          if (settled) return
          await new Promise<void>(resolve => { wake = resolve })
        }
      } finally { if (!settled) stop() }
    },
    async verify(): Promise<WorkerCleanup> {
      await done
      signal?.throwIfAborted()
      if (failure) throw failure
      if (!complete) throw new Error('模型输出未完整结束')
      return { kind: forced ? 'forced' : 'normal', durationMs: Math.round(performance.now() - (cleanupStarted ?? performance.now())), ...(cleanupReason ? { reason: cleanupReason } : {}) }
    },
  }
}
