import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchesToolPattern, selectTools } from '../src/tool-policy.ts'

const tool = name => ({ name, description: '', parameters: { type: 'object' } })
const tools = ['bash', 'read', 'mcp__openviking__read', 'mcp__tapd__get_todo', 'mcp__gongfeng__gongfeng_list_branches'].map(tool)
const names = selected => selected.map(item => item.name)

test('没有策略时返回全部工具', () => {
  assert.deepEqual(names(selectTools(tools)), names(tools))
})

test('deny 支持精确名称和 * 前缀，deny 优先', () => {
  assert.deepEqual(names(selectTools(tools, { deny: ['mcp__*'] })), ['bash', 'read'])
  assert.deepEqual(names(selectTools(tools, { deny: ['mcp__tapd__*', 'mcp__gongfeng__*'] })), ['bash', 'read', 'mcp__openviking__read'])
  assert.deepEqual(names(selectTools(tools, { allow: ['*'], deny: ['bash'] })), ['read', 'mcp__openviking__read', 'mcp__tapd__get_todo', 'mcp__gongfeng__gongfeng_list_branches'])
})

test('allow 支持精确名称和前缀，过滤顺序保持不变', () => {
  assert.deepEqual(names(selectTools(tools, { allow: ['bash', 'mcp__openviking__*'] })), ['bash', 'mcp__openviking__read'])
  assert.deepEqual(names(selectTools(tools, { allow: ['read'] })), ['read'])
})

test('通配符只展开 *，其余字符按字面量匹配', () => {
  assert.equal(matchesToolPattern('mcp__openviking__read', 'mcp__*'), true)
  assert.equal(matchesToolPattern('bash', 'b*'), true)
  assert.equal(matchesToolPattern('bash', 'bash'), true)
  assert.equal(matchesToolPattern('axb', 'a.b'), false)
  assert.equal(matchesToolPattern('a.b', 'a.b'), true)
})

test('过滤后为空时返回空数组，由调用方明确报错', () => {
  assert.deepEqual(selectTools(tools, { deny: ['*'] }), [])
})
