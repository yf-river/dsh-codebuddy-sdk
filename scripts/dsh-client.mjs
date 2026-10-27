import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const cli = '/data/ida/tools/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
const requireDsh = createRequire(cli)
const { JsonRpcLineTransport } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-sdk-protocol')).href)

// 测试客户端只使用 DSH 官方 SDK 协议，与真实 DSH 进程交互。
export function startDsh({ home, cwd, profile, env = {}, requestTimeoutMs = 45_000 }) {
  const child = spawn(process.execPath, [cli, '--profile', profile], {
    cwd, env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: `${home}/agents`, DSH_TELEMETRY_DISABLED: '1', ...env },
  })
  const notifications = []
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  const transport = new JsonRpcLineTransport(child.stdout, child.stdin)
  transport.onNotification((method, params) => notifications.push({ method, params }))
  transport.start()
  const request = (method, params) => transport.request(method, params, AbortSignal.timeout(requestTimeoutMs))
  return {
    request, notifications, pid: child.pid, get stderr() { return stderr },
    async turn(sessionId, text) {
      const offset = notifications.length
      await request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text }] })
      await request('session/wait', { sessionId })
      return notifications.slice(offset).filter(item => item.method === 'session.event').map(item => item.params.event)
    },
    async close() {
      const closed = new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('close', resolve) })
      try { await transport.request('shutdown', {}, AbortSignal.timeout(8_000)) } catch {}
      transport.close()
      child.stdin.end()
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 8_000)
      try { await closed } finally { clearTimeout(timer) }
    },
  }
}
