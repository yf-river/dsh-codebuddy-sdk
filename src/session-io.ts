/**
 * CodeBuddy session file import.
 *
 * The CLI persists a session as JSONL at
 * `~/.codebuddy/projects/<compressed-cwd>/<sessionId>.jsonl`. A resumed
 * session therefore has to exist on disk first, so a Harness session that
 * outlived the CLI process re-imports its history before the first resumed
 * call.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'

type RequestMessage = GenerateOptions['messages'][number]
import { convertMessages } from './convert.js'

export interface ImportedSession {
  sessionId: string
  recordCount: number
}

export function codeBuddyDir(): string {
  return process.env.CODEBUDDY_CONFIG_DIR ?? join(homedir(), '.codebuddy')
}

/** Mirror the CLI's own `PathUtils.compressPath`. */
export function projectPathToHash(projectPath: string): string {
  return projectPath
    .replace(/\/+$/, '')
    .replace(/[/\\:]/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/-+/g, '-')
}

export function sessionPath(sessionId: string, cwd: string): string {
  return join(codeBuddyDir(), 'projects', projectPathToHash(cwd), `${sessionId}.jsonl`)
}

function textOf(content: string | readonly unknown[]): string {
  if (typeof content === 'string') return content
  const blocks = content as readonly ContentBlock[]
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Write the Harness history into a fresh CodeBuddy session file.
 * @param messages - the request history, in order.
 * @param cwd - project directory the session belongs to.
 * @param sessionId - id to reuse for the resumed call.
 * @returns the session id and the number of records written.
 */
export function importSession(
  messages: readonly RequestMessage[],
  cwd: string,
  sessionId: string = randomUUID(),
): ImportedSession {
  const { messages: anthropic } = convertMessages(messages)
  const lines: string[] = []
  let parentId: string | undefined
  const timestamp = Date.now()
  for (const message of anthropic) {
    const id = randomUUID()
    const text = textOf(message.content)
    if (message.role === 'user') {
      lines.push(JSON.stringify({
        id,
        timestamp,
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
        providerData: { agent: 'sdk' },
        sessionId,
        cwd,
      }))
    } else {
      lines.push(JSON.stringify({
        id,
        parentId,
        timestamp,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
        providerData: { agent: 'sdk' },
        sessionId,
        cwd,
      }))
    }
    parentId = id
  }
  const path = sessionPath(sessionId, cwd)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.length > 0 ? `${lines.join('\n')}\n` : '')
  return { sessionId, recordCount: lines.length }
}

/** Whether a session file exists for this id and cwd. */
export function hasSession(sessionId: string, cwd: string): boolean {
  return existsSync(sessionPath(sessionId, cwd))
}

/** Line count of a session file, for post-write verification. */
export function sessionRecordCount(sessionId: string, cwd: string): number {
  const path = sessionPath(sessionId, cwd)
  if (!existsSync(path)) return 0
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0).length
}
