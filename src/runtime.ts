import { fork, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { llmError, type Failure } from './errors.js'
import type { ModelEvent } from './stream.js'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

export interface WorkerRequest { model: string; cwd: string; system: string; input: unknown[]; tools: readonly ToolSchema[]; maxTokens?: number; effort?: string }
export type WorkerReply = { type: 'message'; message: ModelEvent } | { type: 'complete' } | { type: 'failure'; failure: Failure }
export interface WorkerCleanup { kind: 'normal' | 'forced'; durationMs: number; reason?: string }

const GRACE_MS = 5000
const REAP_MS = 1000
// 归属记录保留到实际 close；超时返回不等于宣称无法确认的进程已退出。
const owned = new Set<ChildProcess>()

export function runWorker(request: WorkerRequest, signal?: AbortSignal) {
  const worker = fork(fileURLToPath(new URL('./worker.js', import.meta.url)), [], {
    cwd: request.cwd, execPath: process.execPath, execArgv: [], detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, DISABLE_AUTOUPDATER: '1', CODEBUDDY_DISABLE_AUTO_MEMORY: '1', CODEBUDDY_CODE_DISABLE_AUTO_MEMORY: '1',
      CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1', CODEBUDDY_DISABLE_SYSTEM_REMINDER_MD: '1', CODEBUDDY_PRE_MESSAGE_COMPACT: '0',
      CODEBUDDY_MAX_RETRIES: '0', CODEBUDDY_MODEL_401_MAX_RETRIES: '0', CODEBUDDY_RETRY_WATCHDOG: '0' },
  })
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
  worker.stderr!.on('data', () => {}) // SDK 日志可能含账户信息，不转发或保存。
  worker.on('message', (reply: WorkerReply) => {
    if (settled) return
    if (reply.type === 'message') {
      queue.push(reply.message)
      if (reply.message.type === 'response_done' && !complete) arm()
    } else if (reply.type === 'complete') {
      if (!complete) { complete = true; arm(!signal?.aborted && !failure) }
    } else if (complete) {
      cleanupReason ??= 'cleanup-error'
      stop()
    } else { failure ??= llmError(reply.failure); stop() }
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
  worker.send({ type: 'request', request }, error => { if (error && !settled) { failure ??= error; stop(); notify() } })
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
