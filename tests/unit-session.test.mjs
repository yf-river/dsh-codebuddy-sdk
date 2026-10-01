import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasSession, importSession, projectPathToHash, sessionPath, sessionRecordCount } from '../src/session-io.ts'

let configDir
const previous = process.env.CODEBUDDY_CONFIG_DIR

before(() => {
  configDir = mkdtempSync(join(tmpdir(), 'dsh-codebuddy-'))
  process.env.CODEBUDDY_CONFIG_DIR = configDir
})

after(() => {
  if (previous === undefined) delete process.env.CODEBUDDY_CONFIG_DIR
  else process.env.CODEBUDDY_CONFIG_DIR = previous
  rmSync(configDir, { recursive: true, force: true })
})

function user(text) {
  return {
    id: `m-${Math.random()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

describe('session import', () => {
  it('compresses project paths like the CLI', () => {
    assert.equal(projectPathToHash('/Users/me/project/'), 'Users-me-project')
    assert.equal(projectPathToHash('C:\\work\\repo'), 'C-work-repo')
  })

  it('writes a resumable session file', () => {
    const cwd = join(configDir, 'project')
    const { sessionId, recordCount } = importSession([user('one'), user('two')], cwd)
    assert.equal(recordCount, 2)
    assert.equal(hasSession(sessionId, cwd), true)
    assert.equal(sessionRecordCount(sessionId, cwd), 2)
    assert.equal(sessionPath(sessionId, cwd).startsWith(configDir), true)
  })
})
