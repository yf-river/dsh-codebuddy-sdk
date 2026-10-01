import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toStreamChunks } from '../src/stream.ts'

async function collect(events) {
  const chunks = []
  for await (const chunk of toStreamChunks((async function* () { for (const event of events) yield event })())) {
    chunks.push(chunk)
  }
  return chunks
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

describe('toStreamChunks', () => {
  it('translates text deltas and a successful result', async () => {
    const chunks = await collect([
      {
        type: 'stream_event',
        uuid: 'u1',
        session_id: 's1',
        parent_tool_use_id: null,
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'stream_event',
        uuid: 'u1',
        session_id: 's1',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      },
      assistant([{ type: 'text', text: 'hi' }]),
      {
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
      },
    ])
    assert.deepEqual(chunks.map((chunk) => chunk.type), [
      'block-start', 'text-delta', 'block-end', 'usage', 'finish',
    ])
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
  })

  it('ends a tool-use turn as tool-calls', async () => {
    const chunks = await collect([
      assistant([{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.ts' } }], 'tool_use'),
    ])
    const toolCalls = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    assert.equal(toolCalls.length, 1)
    assert.equal(toolCalls[0].block.arguments, '{"path":"a.ts"}')
  })

  it('reports a result error as an error finish', async () => {
    const chunks = await collect([
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
    const chunks = await collect([message])
    assert.deepEqual(chunks.at(-1).reason, {
      kind: 'error',
      failure: { message: 'upstream down', code: 'CODEBUDDY_ERROR' },
    })
  })
})
