/**
 * Guarantee the CodeBuddy CLI child process is reaped.
 *
 * `@tencent-ai/agent-sdk`'s `query()` closes its transport only when its
 * iterator reaches the terminal message. Paths that abandon the iterator
 * (model discovery, canceled turns) would otherwise leak a child process for
 * the lifetime of the host, so every completion path calls this.
 */

interface ClosableTransport {
  close?: () => void
  process?: { pid?: number }
}

export interface TeardownOptions {
  forceKillAfterMs?: number
  log?: (message: string) => void
}

export function closeQueryTransport(query: unknown, label: string, options: TeardownOptions = {}): void {
  const transport = (query as { transport?: ClosableTransport | null } | null | undefined)?.transport
  if (!transport || typeof transport.close !== 'function') return
  const pid = typeof transport.process?.pid === 'number' ? transport.process.pid : undefined
  try {
    transport.close()
    options.log?.(`teardown(${label}): transport closed${pid === undefined ? '' : ` (pid ${pid})`}`)
  } catch (error) {
    options.log?.(`teardown(${label}): transport close failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (pid === undefined) return
  const timer = setTimeout(() => {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    try {
      process.kill(pid, 'SIGKILL')
      options.log?.(`teardown(${label}): pid ${pid} survived close, sent SIGKILL`)
    } catch {
      // Raced with exit.
    }
  }, options.forceKillAfterMs ?? 2000)
  timer.unref?.()
}

export function endQuery(query: unknown, label: string, options: TeardownOptions = {}): void {
  try {
    void (query as { interrupt?: () => Promise<unknown> } | null | undefined)?.interrupt?.()?.catch?.(() => {})
  } catch {
    // Expected on a half-dead transport.
  }
  closeQueryTransport(query, label, options)
}
