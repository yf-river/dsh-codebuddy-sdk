/**
 * Opt-in integration test against the real CodeBuddy CLI.
 *
 * Skipped unless `CODEBUDDY_SDK_INTEGRATION=1` and the CLI is signed in, so
 * ordinary CI never depends on a machine's credentials or network.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { query } from '@tencent-ai/agent-sdk'
import { toStreamChunks } from '../src/stream.ts'

const enabled = process.env.CODEBUDDY_SDK_INTEGRATION === '1' && spawnSync('codebuddy', ['--version']).status === 0

describe('CodeBuddy CLI integration', { skip: !enabled }, () => {
  it('streams one text answer through the Harness chunk protocol', async () => {
    const child = query({
      prompt: 'Reply with just the word pong',
      options: { permissionMode: 'bypassPermissions', tools: [], includePartialMessages: true },
    })
    const chunks = []
    for await (const chunk of toStreamChunks(child)) chunks.push(chunk)
    const text = chunks
      .filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text')
      .map((chunk) => chunk.block.text)
      .join('')
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.match(text, /pong/i)
  })
})
