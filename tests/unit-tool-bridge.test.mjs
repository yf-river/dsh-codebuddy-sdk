import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CodeBuddyToolBridge } from '../src/tool-bridge.ts'

describe('CodeBuddyToolBridge', () => {
  it('queues a result that arrives before its handler and returns it in order', () => {
    const bridge = new CodeBuddyToolBridge([])
    bridge.noteToolCall('call_1')
    assert.equal(bridge.deliver('call_1', { content: [{ type: 'text', text: 'done' }] }), false)
  })

  it('resolves a waiting handler when its result arrives', async () => {
    const bridge = new CodeBuddyToolBridge([])
    bridge.noteToolCall('call_1')
    assert.equal(bridge.deliver('call_2', { content: [{ type: 'text', text: 'other' }] }), false)
    assert.equal(bridge.deliver('call_1', { content: [{ type: 'text', text: 'mine' }] }), false)
  })

  it('fails every waiting handler so a torn-down query can exit', () => {
    const bridge = new CodeBuddyToolBridge([])
    bridge.noteToolCall('call_1')
    bridge.failAll('conversation ended')
    assert.equal(bridge.waiting, 0)
  })
})
