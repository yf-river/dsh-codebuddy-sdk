import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { convertMessages, lastUserText, mapHarnessToolNameToSdk, sanitizeToolId } from '../src/convert.ts'

function textMessage(role, text) {
  return {
    id: `m-${Math.random()}`,
    role,
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

describe('convertMessages', () => {
  it('keeps user turns as text', () => {
    const { messages } = convertMessages([textMessage('user', 'hello')])
    assert.deepEqual(messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
  })

  it('maps assistant tool calls and joins the result to the same user turn', () => {
    const messages = [
      textMessage('user', 'read it'),
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' }],
        source: { kind: 'model', provider: 'codebuddy', model: 'hy3' },
      },
      {
        id: 't1',
        role: 'tool',
        content: [{ type: 'text', text: 'contents' }],
        source: { kind: 'tool', callId: 'call_1' },
        toolCallId: 'call_1',
      },
    ]
    const { messages: converted } = convertMessages(messages)
    assert.equal(converted.length, 3)
    assert.equal(converted[1].role, 'assistant')
    assert.equal(converted[1].content[0].type, 'tool_use')
    assert.equal(converted[1].content[0].name, 'Read')
    assert.equal(converted[2].role, 'user')
    assert.equal(converted[2].content[0].type, 'tool_result')
    assert.equal(converted[2].content[0].content, 'contents')
  })

  it('synthesizes a result for a tool call left open by a cut history', () => {
    const messages = [
      {
        id: 'a2',
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call_2', name: 'bash', arguments: '{}' }],
        source: { kind: 'model', provider: 'codebuddy', model: 'hy3' },
      },
    ]
    const { messages: converted } = convertMessages(messages)
    const result = converted.at(-1)
    assert.equal(result.role, 'user')
    assert.equal(result.content[0].type, 'tool_result')
    assert.equal(result.content[0].is_error, true)
  })

  it('sanitizes provider ids while keeping distinct ids distinct', () => {
    const cache = new Map()
    assert.equal(sanitizeToolId('call.a:b', cache), 'call_a_b')
    assert.equal(sanitizeToolId('call.a:b', cache), 'call_a_b')
    assert.equal(sanitizeToolId('call.c:d', cache), 'call_c_d')
  })

  it('maps known Harness tool names and falls back to PascalCase', () => {
    assert.equal(mapHarnessToolNameToSdk('read'), 'Read')
    assert.equal(mapHarnessToolNameToSdk('web_search'), 'WebSearch')
  })

  it('returns the final user text', () => {
    assert.equal(lastUserText([textMessage('user', 'first'), textMessage('user', 'second')]), 'second')
  })
})
