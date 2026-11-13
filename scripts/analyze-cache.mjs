// 只读分析解压后的 DSH 日志；费用以 cost-meter 账本为准。
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const [logsDir, ledgerPath] = process.argv.slice(2)
if (!logsDir || !ledgerPath) throw new Error('Usage: node scripts/analyze-cache.mjs <JSONL directory> <cost-meter ledger.json>')
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
const costs = new Map()
for (const day of Object.values(ledger.days)) for (const session of day.sessions ?? []) {
  const total = costs.get(session.id) ?? { title: session.title, cny: 0, calls: 0, input: 0, output: 0, cacheRead: 0 }
  for (const key of ['calls', 'input', 'output', 'cacheRead']) total[key] += session[key] ?? 0
  total.cny += session.costCny ?? 0
  costs.set(session.id, total)
}
// 同一会话可能有多个时间点的导出；只保留事件数最多的副本。
const candidates = new Map()
for (const file of readdirSync(logsDir).filter(file => file.endsWith('.jsonl'))) {
  let count = 0, header
  for (const line of readFileSync(resolve(logsDir, file), 'utf8').split('\n')) {
    if (!line.trim()) continue
    const event = JSON.parse(line)
    if (event.type === 'session') header = event
    count++
  }
  if (!header) continue
  if ((candidates.get(header.id)?.count ?? 0) < count) candidates.set(header.id, { header, file, count })
}
const rows = []
for (const { header, file } of candidates.values()) {
  const events = readFileSync(resolve(logsDir, file), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  const calls = events.filter(event => event.type === 'assistant/message' && event.data.usage && event.time >= header.createdAt)
  const oversized = events.filter(event => event.type === 'tool/result' && event.time >= header.createdAt).flatMap(event => {
    const bytes = Buffer.byteLength(event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    return bytes > 50 * 1024 ? [{ seq: event.seq, bytes, callId: event.data.message.source?.callId }] : []
  })
  let miss = 0, hit = 0, maxCache = 0, maxContext = 0, afterMiss = 0, recoveryUpperTokens = 0, previous
  const routes = new Set()
  for (const call of calls) {
    const usage = call.data.usage
    const input = usage.inputTokens ?? 0, cache = usage.cacheReadTokens ?? 0
    const context = input + cache + (usage.cacheWriteTokens ?? 0)
    const route = `${call.data.message.source?.provider}:${call.data.message.source?.model}`
    routes.add(route)
    miss += input; hit += cache
    maxCache = Math.max(maxCache, cache); maxContext = Math.max(maxContext, context)
    if (route === 'codebuddy:deepseek-v4.1-flash' && oversized[0]?.seq < call.seq) {
      afterMiss += input
      // 相邻请求可复用的旧输入上界；排除路由、system、工具声明和历史替换变化。
      const changed = previous && events.some(event => event.seq > previous.seq && event.seq < call.seq
        && (event.type === 'system/message' || event.type === 'request/header' || event.surfaceOp === 'replace'))
      if (previous && previous.route === route && !changed) recoveryUpperTokens += Math.max(0, Math.min(input, Math.floor(previous.context / 512) * 512 - cache))
    }
    previous = { seq: call.seq, route, context }
  }
  rows.push({ id: header.id, file, cwd: header.cwd, ledger: costs.get(header.id), routes: [...routes],
    loggedCalls: calls.length, miss, hit, hitRate: hit / (hit + miss), maxCache, maxContext, oversized,
    missAfterFirstOversized: afterMiss, recoveryUpperTokens,
    // 当前账本默认 Flash 价的情景估算；不是订阅扣量，也不是已实现收益。
    recoveryUpperCnyOffPeak: recoveryUpperTokens / 1e6 * (0.15 - 0.003) * ledger.config.exchangeRate,
  })
}
rows.sort((a, b) => (b.ledger?.cny ?? 0) - (a.ledger?.cny ?? 0))
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), sessions: rows.length,
  ledgerCny: [...costs.values()].reduce((sum, row) => sum + row.cny, 0),
  scope: 'assistant/message usage; excludes unsettled attempts and auxiliary search; inherited events excluded by createdAt', rows }, null, 2))
