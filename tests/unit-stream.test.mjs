import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { translateStep } from '../src/stream.ts'
import { CodeBuddyToolBridge } from '../src/tool-bridge.ts'

/** Feed a finite list of messages, then report done; never call return(). */
function iteratorOf(events) {
  let index = 0
  return {
    returnCalls: 0,
    async next() {
      if (index >= events.length) return { done: true, value: undefined }
      return { done: false, value: events[index++] }
    },
    async return() {
      this.returnCalls += 1
      return { done: true, value: undefined }
    },
  }
}

async function collect(events, bridge = new CodeBuddyToolBridge([])) {
  const source = iteratorOf(events)
  const chunks = []
  const step = translateStep(source, bridge)
  while (true) {
    const next = await step.next()
    if (next.done) return { chunks, status: next.value, source }
    chunks.push(next.value)
  }
}

function assistant(content, stopReason = 'end_turn') {
  return {
    type: 'assistant',
    uuid: 'u1',
    session_id: 's1',
    parent_tool_use_id: null,
    message: {
      id: 'msg1',
      type: 'message',
      role: 'assistant',
      model: 'hy3',
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 4 },
    },
  }
}

function streamEvent(event) {
  return { type: 'stream_event', uuid: 'u1', session_id: 's1', parent_tool_use_id: null, event }
}

function successResult() {
  return {
    type: 'result',
    subtype: 'success',
    uuid: 'u1',
    session_id: 's1',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: 'hi',
    total_cost_usd: 0,
    usage: { input_tokens: 3, output_tokens: 4 },
    permission_denials: [],
  }
}

describe('translateStep', () => {
  it('translates text deltas and a successful result', async () => {
    const { chunks, status } = await collect([
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
      assistant([{ type: 'text', text: 'hi' }]),
      successResult(),
    ])
    assert.deepEqual(chunks.map((chunk) => chunk.type), [
      'block-start', 'text-delta', 'block-end', 'usage', 'finish',
    ])
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
    assert.equal(status.ended, true)
  })

  it('ends a tool-use turn as tool-calls without closing the iterator', async () => {
    const bridge = new CodeBuddyToolBridge([])
    const { chunks, status, source } = await collect([
      streamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_1', name: 'Read', input: {} },
      }),
      streamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' },
      }),
      streamEvent({ type: 'content_block_stop', index: 0 }),
      assistant([{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.ts' } }], 'tool_use'),
    ], bridge)
    const toolCalls = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    assert.equal(toolCalls.length, 1)
    assert.equal(toolCalls[0].block.arguments, '{"path":"a.ts"}')
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
    assert.equal(status.awaitingTool, true)
    assert.equal(status.ended, false)
    // Returning early from a `for await` would have called this and killed the CLI.
    assert.equal(source.returnCalls, 0)
  })

  it('reports a result error as an error finish', async () => {
    const { chunks } = await collect([
      {
        type: 'result',
        subtype: 'error_during_execution',
        uuid: 'u1',
        session_id: 's1',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: true,
        num_turns: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        permission_denials: [],
        errors: ['boom'],
      },
    ])
    assert.deepEqual(chunks.at(-1).reason, {
      kind: 'error',
      failure: { message: 'boom', code: 'CODEBUDDY_ERROR' },
    })
  })

  it('turns an assistant error field into an error finish', async () => {
    const message = { ...assistant([{ type: 'text', text: 'partial' }]), error: 'upstream down' }
    const { chunks } = await collect([message])
    assert.deepEqual(chunks.at(-1).reason, {
      kind: 'error',
      failure: { message: 'upstream down', code: 'CODEBUDDY_ERROR' },
    })
  })
})
