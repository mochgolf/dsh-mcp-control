/**
 * P3: `events_read` against real durable Session logs written through the
 * production JSONL persistence. The logs are seeded through the production
 * `Session` API, so paging, alignment, digests, and reassembly are exercised
 * against the same data a live run would leave behind.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionSeq as SessionSeqType } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Client } from '@modelcontextprotocol/client'
import { loadStoredSession, seedStoredSession } from './support/persistence.ts'
import { jsonBytes, okResult } from '../src/result.ts'
import { textResponse } from './support/mock-adapter.ts'
import {
  bootHarness,
  closeAll,
  connectClient,
  seedSession,
  TEST_TOKEN,
  textJson,
  type Harness,
} from './harness.ts'

const harnesses: Harness[] = []
const clients: Client[] = []

afterEach(async () => {
  await closeAll(clients.splice(0), harnesses.splice(0))
})

async function boot(options: Parameters<typeof bootHarness>[0] = {}): Promise<Harness> {
  const harness = await bootHarness(options)
  harnesses.push(harness)
  return harness
}

async function clientFor(harness: Harness): Promise<Client> {
  const client = await connectClient(`${harness.baseUrl}/mcp`)
  clients.push(client)
  return client
}

/** One page read through the endpoint. */
async function page(
  client: Client,
  sessionId: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await client.callTool({
    name: 'events_read',
    arguments: { address: { kind: 'session', session_id: sessionId }, ...args },
  })
  if (result.isError === true) throw new Error(`events_read failed: ${JSON.stringify(result.structuredContent)}`)
  return textJson(result)
}

/** One failing tool call's structured error. */
async function failure(
  client: Client,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name: 'events_read', arguments: args })
  expect(result.isError, `events_read unexpectedly succeeded: ${JSON.stringify(args)}`).toBe(true)
  return textJson(result).error as Record<string, unknown>
}

/**
 * One complete turn with a single human message. The turn is closed explicitly
 * so the seeded log never needs the reader's unterminated-turn repair.
 * @returns the seq of the appended human message.
 */
function userTurn(session: Session, text: string, turn: number): SessionSeqType {
  session.append('turn/start', { turn })
  const message = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return message.seq
}

/** Fill a log with `count` durable non-message events between two messages. */
function fill(session: Session, count: number, provider: string): void {
  for (let index = 0; index < count; index += 1) {
    session.append('request/context', { provider, model: `model-${String(index)}` })
  }
}

/** Read every page from the first event and concatenate the delivered events. */
async function readAll(client: Client, sessionId: string, maxEvents: number): Promise<unknown[]> {
  const collected: unknown[] = []
  let after = -1
  for (let guard = 0; guard < 10_000; guard += 1) {
    const answer = await page(client, sessionId, { after_seq: after, max_events: maxEvents })
    const events = answer.events as unknown[]
    collected.push(...events)
    if (answer.has_more !== true) return collected
    const next = answer.next_seq as number
    expect(next, 'has_more must advance next_seq').toBeGreaterThan(after)
    after = next
  }
  throw new Error('paging did not terminate')
}

/**
 * Seed a durable Session under one exact working directory, so a case can size
 * the page header (which carries it) against the result budget.
 */
async function seedWithCwd(
  harness: Harness,
  id: string,
  cwd: string,
  build: (session: Session) => void,
): Promise<void> {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1_700_000_000_000,
    isSeeded: false,
    cwd,
  }
  const session = Session.create(SessionId(id), undefined, header)
  build(session)
  await seedStoredSession(harness.ctx.sessionPersistence, session.header, session.snapshotEvents())
}

describe('events_read cursors', () => {
  it('reports an empty log and refuses a cursor past the watermark', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    await seedSession(harness, 'empty-log', () => {})
    const empty = await page(client, 'empty-log')
    expect(empty).toMatchObject({ mode: 'page', head_seq: -1, next_seq: -1, has_more: false })
    expect(empty.events).toEqual([])
    expect(empty.header).toMatchObject({ id: 'empty-log', cwd: harness.workspace })

    const ahead = await failure(client, {
      address: { kind: 'session', session_id: 'empty-log' },
      after_seq: 5,
    })
    expect(ahead.code).toBe('mcp-control/cursor-ahead')
  })

  it('starts at the first event for after_seq -1 and stops exactly at the watermark', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    const stored = await seedSession(harness, 'first-event', (session) => {
      userTurn(session, 'only message', 1)
    })
    const first = await page(client, 'first-event', { after_seq: -1 })
    expect(first.head_seq).toBe(stored.length - 1)
    expect(first.events).toEqual(stored)

    const atHead = await page(client, 'first-event', { after_seq: first.head_seq as number })
    expect(atHead).toMatchObject({ next_seq: first.head_seq, has_more: false })
    expect(atHead.events).toEqual([])

    const ahead = await failure(client, {
      address: { kind: 'session', session_id: 'first-event' },
      after_seq: (first.head_seq as number) + 1,
    })
    expect(ahead).toMatchObject({ code: 'mcp-control/cursor-ahead', details: { head_seq: String(first.head_seq) } })
  })

  it('rejects a negative cursor, a zero max_events, and a chunk digest that is not hexadecimal', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    await seedSession(harness, 'validation', (session) => { userTurn(session, 'one', 1) })
    for (const args of [
      { address: { kind: 'session', session_id: 'validation' }, after_seq: -2 },
      { address: { kind: 'session', session_id: 'validation' }, max_events: 0 },
      { address: { kind: 'session', session_id: 'validation' }, max_events: 1.5 },
      { address: { kind: 'session', session_id: 'validation' }, mode: 'chunk', event_seq: 0, offset: 0, sha256: 'NOPE' },
    ]) {
      const result = await client.callTool({ name: 'events_read', arguments: args })
      expect(result.isError, JSON.stringify(args)).toBe(true)
    }
  })
})

describe('events_read paging', () => {
  it('reassembles the complete log from small pages without skipping or repeating an event', { timeout: 60_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    const stored = await seedSession(harness, 'dense-log', (session) => {
      let earlier = SessionSeq(0)
      for (let turn = 1; turn <= 12; turn += 1) {
        earlier = userTurn(session, `message ${String(turn)}`, turn)
        fill(session, 5, 'mock')
        if (turn % 4 === 0) {
          session.append('user/message', createUserMessage({
            content: [{ type: 'text', text: `summary of ${String(turn)}` }],
            source: { kind: 'user' },
          }), { surfaceOp: 'append', sourceEventSeqs: [earlier] })
        }
      }
    })
    expect(stored.length).toBeGreaterThan(50)
    const collected = await readAll(client, 'dense-log', 3)
    expect(collected).toEqual(stored)
    // The durable artifact itself, read independently of this endpoint, is the oracle.
    const durable = await loadStoredSession(harness.ctx.sessionPersistence, SessionId('dense-log'))
    expect(collected).toEqual(durable.events)
  })

  it('serves a bounded window from a very old cursor with one native page read', { timeout: 60_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    const stored = await seedSession(harness, 'old-cursor', (session) => {
      for (let turn = 1; turn <= 40; turn += 1) {
        userTurn(session, `message ${String(turn)}`, turn)
        fill(session, 3, 'mock')
      }
    })
    const head = stored.length - 1
    const nativePage = vi.spyOn(harness.ctx.sessionController, 'page')
    const answer = await page(client, 'old-cursor', { after_seq: 4, max_events: 7 })
    expect(answer.head_seq).toBe(head)
    expect(answer.events).toEqual(stored.slice(5, 12))
    expect(answer.next_seq).toBe(11)
    expect(answer.has_more).toBe(true)
    // One point read positions the window; the reader never scans pages backwards.
    expect(nativePage).toHaveBeenCalledTimes(1)
    nativePage.mockRestore()
  })

  it('freezes the page at its opening watermark and resumes past events appended meanwhile', { timeout: 60_000 }, async () => {
    const harness = await boot({ script: [textResponse('first turn'), textResponse('second turn')] })
    const client = await clientFor(harness)
    await client.callTool({
      name: 'session_start',
      arguments: { cwd: harness.workspace, prompt: 'first turn', session_id: 'append-during-read' },
    })
    await harness.ctx.agents.get(SessionId('append-during-read'))!.whenIdle()

    const first = await page(client, 'append-during-read', { after_seq: -1, max_events: 2 })
    const firstSeqs = (first.events as Array<{ seq: number }>).map(event => event.seq)
    expect(firstSeqs).toEqual([0, 1])
    expect(first.has_more).toBe(true)

    // Append through the live Session while holding the first page's cursor.
    const live = harness.ctx.sessions.get(SessionId('append-during-read'))
    if (live === undefined) throw new Error('the started session is not attached')
    const appended = [
      live.append('request/context', { provider: 'mock', model: 'appended-later' }).seq,
      live.append('request/context', { provider: 'mock', model: 'appended-later-2' }).seq,
    ]

    const resumed = await page(client, 'append-during-read', { after_seq: first.next_seq as number, max_events: 2 })
    expect((resumed.head_seq as number)).toBeGreaterThan(first.head_seq as number)
    const resumedSeqs = (resumed.events as Array<{ seq: number }>).map(event => event.seq)
    expect(new Set([...firstSeqs, ...resumedSeqs]).size).toBe(firstSeqs.length + resumedSeqs.length)

    const tail: Array<{ seq: number; data: { model?: string } }> = []
    let after = first.next_seq as number
    for (let guard = 0; guard < 100; guard += 1) {
      const answer = await page(client, 'append-during-read', { after_seq: after, max_events: 4 })
      tail.push(...answer.events as Array<{ seq: number; data: { model?: string } }>)
      if (answer.has_more !== true) break
      after = answer.next_seq as number
    }
    const bySeq = new Map(tail.map(event => [event.seq, event]))
    expect(appended.map(seq => bySeq.get(seq)?.data.model)).toEqual(['appended-later', 'appended-later-2'])
    const repeated = await page(client, 'append-during-read', { after_seq: -1, max_events: 2 })
    expect(repeated.events).toEqual(first.events)
  })

  it('never activates the Agent of a cold session, across repeated reads', { timeout: 60_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    await seedSession(harness, 'cold-read', (session) => {
      userTurn(session, 'stored only', 1)
      fill(session, 3, 'mock')
    })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = await page(client, 'cold-read', { after_seq: -1 })
      expect((answer.events as unknown[]).length).toBeGreaterThan(0)
    }
    expect(harness.ctx.agents.get(SessionId('cold-read'))).toBeUndefined()
  })

  it('rejects an unknown session and a subagent address whose parent does not own it', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    await seedSession(harness, 'plain-root', (session) => { userTurn(session, 'plain', 1) })
    expect((await failure(client, { address: { kind: 'session', session_id: 'no-such-session' } })).code)
      .toBe('session/not-found')
    const wrongParent = await failure(client, {
      address: {
        kind: 'subagent',
        parent_session_id: 'plain-root',
        child_session_id: 'plain-root',
        mode: 'continuable',
      },
    })
    expect(['subagent/unauthorized', 'subagent/not-found', 'session/agent-busy']).toContain(wrongParent.code)
  })
})

describe('events_read oversized events', () => {
  /** A payload that is both large and multi-byte, so chunk boundaries split code points. */
  const HUGE_TEXT = `${'汉字🙂'.repeat(40_000)}END`

  it('reports an oversized event and reassembles it byte-exactly through chunk mode', { timeout: 60_000 }, async () => {
    const harness = await boot({
      config: { maxToolResultBytes: 8192, defaultChunkBytes: 2048, maxRequestBytes: 1 << 20 },
    })
    const client = await clientFor(harness)
    const stored = await seedSession(harness, 'huge-event', (session) => {
      userTurn(session, 'small first', 1)
      session.append('turn/start', { turn: 2 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: HUGE_TEXT }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      userTurn(session, 'small last', 3)
    })
    const huge = stored.find(event => event.type === 'user/message'
      && (event.data as { content: Array<{ text?: string }> }).content[0]?.text === HUGE_TEXT)
    if (huge === undefined) throw new Error('seeded huge event missing')
    const hex = createHash('sha256').update(Buffer.from(JSON.stringify(huge), 'utf8')).digest('hex')

    // A page starting at the huge event cannot deliver it, so it reports the descriptor.
    const answer = await page(client, 'huge-event', { after_seq: (huge.seq as number) - 1 })
    const delivered = (answer.events as Array<{ seq: number }>).map(event => event.seq)
    expect(delivered).not.toContain(huge.seq)
    expect(answer.oversized_event).toEqual({ seq: huge.seq, byte_length: Buffer.byteLength(JSON.stringify(huge)), sha256: hex })
    expect(answer.next_seq).toBe((huge.seq as number) - 1)
    expect(answer.has_more).toBe(true)

    let offset = 0
    const chunks: Buffer[] = []
    for (let guard = 0; guard < 1000; guard += 1) {
      const result = await client.callTool({
        name: 'events_read',
        arguments: {
          mode: 'chunk',
          address: { kind: 'session', session_id: 'huge-event' },
          event_seq: huge.seq,
          offset,
          sha256: hex,
        },
      })
      expect(result.isError ?? false).toBe(false)
      const chunk = textJson(result)
      expect(chunk).toMatchObject({ mode: 'chunk', encoding: 'base64', event_seq: huge.seq, sha256: hex })
      expect(chunk.offset).toBe(offset)
      const data = Buffer.from(chunk.data as string, 'base64')
      chunks.push(data)
      offset = chunk.next_offset as number
      if (chunk.done === true) break
    }
    const assembled = Buffer.concat(chunks)
    expect(assembled.byteLength).toBe(Buffer.byteLength(JSON.stringify(huge)))
    expect(createHash('sha256').update(assembled).digest('hex')).toBe(hex)
    expect(JSON.parse(assembled.toString('utf8'))).toEqual(huge)
  })

  it('serves the same chunk for an unbounded max_bytes as for the result budget', { timeout: 30_000 }, async () => {
    const budget = 4096
    const harness = await boot({ config: { maxToolResultBytes: budget, defaultChunkBytes: 1024 } })
    const client = await clientFor(harness)
    const huge = 'y'.repeat(40_000)
    const stored = await seedSession(harness, 'unbounded-chunk', (session) => {
      userTurn(session, 'small first', 1)
      session.append('turn/start', { turn: 2 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: huge }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    })
    const descriptor = stored.at(-1)
    if (descriptor === undefined) throw new Error('seeded huge event missing')
    const hex = createHash('sha256').update(Buffer.from(JSON.stringify(descriptor), 'utf8')).digest('hex')
    const read = async (maxBytes: number): Promise<Record<string, unknown>> => textJson(await client.callTool({
      name: 'events_read',
      arguments: {
        mode: 'chunk',
        address: { kind: 'session', session_id: 'unbounded-chunk' },
        event_seq: descriptor.seq,
        offset: 0,
        max_bytes: maxBytes,
        sha256: hex,
      },
    }))
    // The requested size never enlarges the chunk the budget admits, so the
    // caller cannot make the endpoint encode an event it will refuse to send.
    const bounded = await read(budget)
    expect(await read(1_000_000_000)).toEqual(bounded)
    expect(jsonBytes(okResult(bounded))).toBeLessThanOrEqual(budget)
    expect(bounded.done).toBe(false)
  })

  it('refuses a stale digest and an offset past the end without advancing anything', { timeout: 30_000 }, async () => {
    const harness = await boot({ config: { maxToolResultBytes: 8192, defaultChunkBytes: 2048 } })
    const client = await clientFor(harness)
    await seedSession(harness, 'digest-event', (session) => { userTurn(session, 'payload', 1) })
    const wrong = await failure(client, {
      mode: 'chunk',
      address: { kind: 'session', session_id: 'digest-event' },
      event_seq: 1,
      offset: 0,
      sha256: 'f'.repeat(64),
    })
    expect(wrong.code).toBe('mcp-control/event-changed')

    const stored = await loadStoredSession(harness.ctx.sessionPersistence, SessionId('digest-event'))
    const bytes = Buffer.byteLength(JSON.stringify(stored.events[1]))
    const hex = createHash('sha256').update(Buffer.from(JSON.stringify(stored.events[1]), 'utf8')).digest('hex')
    const beyond = await failure(client, {
      mode: 'chunk',
      address: { kind: 'session', session_id: 'digest-event' },
      event_seq: 1,
      offset: bytes + 1,
      sha256: hex,
    })
    expect(beyond.code).toBe('mcp-control/invalid-offset')

    const result = await client.callTool({
      name: 'events_read',
      arguments: {
        mode: 'chunk',
        address: { kind: 'session', session_id: 'digest-event' },
        event_seq: 1,
        offset: bytes,
        sha256: hex,
      },
    })
    expect(textJson(result)).toMatchObject({ data: '', offset: bytes, next_offset: bytes, done: true })
  })
})

describe('events_read result budget', () => {
  it('delivers the largest prefix that fits and leaves the rest for the next page', { timeout: 60_000 }, async () => {
    const harness = await boot({ config: { maxToolResultBytes: 8192, defaultChunkBytes: 1024 } })
    const client = await clientFor(harness)
    const stored = await seedSession(harness, 'prefix-budget', (session) => {
      for (let turn = 1; turn <= 8; turn += 1) {
        userTurn(session, `payload ${'x'.repeat(1500)} ${String(turn)}`, turn)
      }
    })
    const answer = await page(client, 'prefix-budget', { after_seq: -1, max_events: 8 })
    const delivered = answer.events as Array<{ seq: number }>
    expect(delivered.length).toBeGreaterThan(0)
    expect(delivered.length).toBeLessThan(stored.length)
    // A contiguous prefix, in order, with the cursor left on the last delivered event.
    expect(delivered.map(event => event.seq)).toEqual(stored.slice(0, delivered.length).map(event => event.seq))
    expect(answer.next_seq).toBe(delivered.at(-1)?.seq)
    expect(answer.has_more).toBe(true)
    const resumed = await page(client, 'prefix-budget', { after_seq: answer.next_seq as number, max_events: 8 })
    expect((resumed.events as Array<{ seq: number }>)[0]?.seq).toBe((delivered.at(-1)?.seq ?? -1) + 1)
  })

  it('runs the compact turn collector through pages and verified chunks', { timeout: 60_000 }, async () => {
    const harness = await boot({
      script: [textResponse('compact final answer')],
      config: { maxToolResultBytes: 8192, defaultChunkBytes: 2048, maxRequestBytes: 1 << 20 },
    })
    const hugeText = `${'汉字🙂'.repeat(6_000)}END`
    const client = await clientFor(harness)
    const started = textJson(await client.callTool({
      name: 'session_start',
      arguments: {
        cwd: harness.workspace,
        prompt: hugeText,
        session_id: 'collector-example',
        request_id: 'collector-request',
      },
    }))
    expect(started.accepted).toBe(true)
    await harness.ctx.agents.get(SessionId('collector-example'))!.whenIdle()

    const script = fileURLToPath(new URL('../examples/collect-turn.mjs', import.meta.url))
    const { stdout } = await promisify(execFile)(process.execPath, [script], {
      env: {
        DSH_MCP_CONTROL_URL: `${harness.baseUrl}/mcp`,
        DSH_MCP_CONTROL_TOKEN: TEST_TOKEN,
        DSH_MCP_CONTROL_SESSION_ID: 'collector-example',
        DSH_MCP_CONTROL_REQUEST_ID: 'collector-request',
        DSH_MCP_CONTROL_TIMEOUT_MS: '10000',
      },
    })
    expect(JSON.parse(stdout)).toMatchObject({
      session_id: 'collector-example',
      request_id: 'collector-request',
      turn: 1,
      final_message: 'compact final answer',
      reason: { kind: 'completed' },
      diagnostics: [],
    })
    expect(Buffer.byteLength(stdout)).toBeLessThan(512)
  })

  it('reports result-too-large when the page header alone cannot fit', { timeout: 30_000 }, async () => {
    const harness = await boot({ config: { maxToolResultBytes: 4096, defaultChunkBytes: 1024 } })
    const client = await clientFor(harness)
    await seedWithCwd(harness, 'wide-header', `/${'w'.repeat(6000)}`, (session) => { userTurn(session, 'x', 1) })
    const refused = await failure(client, {
      address: { kind: 'session', session_id: 'wide-header' },
      after_seq: -1,
    })
    expect(refused.code).toBe('mcp-control/result-too-large')
  })

  it('reports result-too-large when even the oversized-event descriptor cannot fit', { timeout: 30_000 }, async () => {
    const budget = 4096
    const harness = await boot({ config: { maxToolResultBytes: budget, defaultChunkBytes: 1024 } })
    const client = await clientFor(harness)
    const huge = 'z'.repeat(20_000)
    const base = `/${'b'.repeat(700)}`
    await seedWithCwd(harness, 'descriptor-probe', base, (session) => {
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: huge }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    })
    const probe = await page(client, 'descriptor-probe', { after_seq: 0 })
    const header = probe.header as Record<string, unknown>
    const descriptor = probe.oversized_event as Record<string, unknown>
    const pageValue = (cwd: string, withDescriptor: boolean): Record<string, unknown> => ({
      mode: 'page',
      header: { ...header, cwd },
      head_seq: probe.head_seq,
      next_seq: probe.next_seq,
      events: [],
      has_more: true,
      ...(withDescriptor ? { oversized_event: descriptor } : {}),
    })
    // The cwd appears once in the structured content and once in the escaped
    // JSON text, so each added character costs exactly two bytes.
    const plain = jsonBytes(okResult(pageValue(base, false)))
    const width = base.length + Math.floor((budget - plain) / 2)
    const cwd = `/${'b'.repeat(width - 1)}`
    // The fixture proves its own premise before the endpoint is asked.
    expect(jsonBytes(okResult(pageValue(cwd, false)))).toBeLessThanOrEqual(budget)
    expect(jsonBytes(okResult(pageValue(cwd, true)))).toBeGreaterThan(budget)

    await seedWithCwd(harness, 'descriptor-tight', cwd, (session) => {
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: huge }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    })
    const refused = await failure(client, {
      address: { kind: 'session', session_id: 'descriptor-tight' },
      after_seq: 0,
    })
    expect(refused).toMatchObject({ code: 'mcp-control/result-too-large', details: { event_seq: '1' } })
  })

  it('refuses a chunk for an event the durable log does not contain', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    await seedSession(harness, 'missing-event', (session) => { userTurn(session, 'only', 1) })
    const refused = await failure(client, {
      mode: 'chunk',
      address: { kind: 'session', session_id: 'missing-event' },
      event_seq: 40,
      offset: 0,
      sha256: 'a'.repeat(64),
    })
    expect(refused.code).toBe('gateway/bad-request')
  })

  it('reports a native read failure instead of an empty page', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    await seedSession(harness, 'read-failure', (session) => {
      for (let turn = 1; turn <= 6; turn += 1) userTurn(session, `message ${String(turn)}`, turn)
    })
    vi.spyOn(harness.ctx.sessionController, 'page').mockRejectedValue(
      new RemoteError('gateway/bad-request', 'the log cannot be paged', {}),
    )
    const refused = await failure(client, {
      address: { kind: 'session', session_id: 'read-failure' },
      after_seq: 0,
      max_events: 2,
    })
    expect(refused).toMatchObject({ code: 'gateway/bad-request', details: { after_seq: '0' } })
  })
})

describe('events_read fidelity', () => {
  it('relays surface operations, sources, and ignorable markers verbatim', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    const stored = await seedSession(harness, 'fidelity', (session) => {
      userTurn(session, 'origin', 1)
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'cites the first message' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append', sourceEventSeqs: [SessionSeq(1)] })
      // An unrecognized future event is readable only because it carries the
      // envelope's ignorable marker; the reader must pass it through intact.
      // Its name is outside the compile-time event map by construction.
      const events = session.snapshotEvents()
      return [...events, {
        type: 'future/unknown',
        seq: SessionSeq(events.length),
        time: 1_700_000_000_000 + events.length,
        data: { nested: { list: [1, 'two', null, true] } },
        ignorable: true,
      } as unknown as SessionEvent]
    })
    const answer = await page(client, 'fidelity', { after_seq: -1 })
    expect(answer.events).toEqual(stored)
    const cited = (answer.events as Array<Record<string, unknown>>).find(event => event.type === 'user/message'
      && JSON.stringify(event.data).includes('cites the first message'))
    expect(cited?.sourceEventSeqs).toEqual([1])
    expect(cited?.surfaceOp).toBe('append')
    const unknown = (answer.events as Array<Record<string, unknown>>).find(event => event.type === 'future/unknown')
    expect(unknown?.data).toEqual({ nested: { list: [1, 'two', null, true] } })
    expect(unknown?.ignorable).toBe(true)
  })

  it('returns structured content identical to the JSON text fallback', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    await seedSession(harness, 'structured-equal', (session) => { userTurn(session, 'equal', 1) })
    const result = await client.callTool({
      name: 'events_read',
      arguments: { address: { kind: 'session', session_id: 'structured-equal' }, after_seq: -1 },
    })
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? ''
    expect(JSON.parse(text)).toEqual(result.structuredContent)
  })

  it('fails with result-too-large when the page header alone cannot fit', { timeout: 30_000 }, async () => {
    const harness = await boot({ config: { maxToolResultBytes: 4096, defaultChunkBytes: 1024 } })
    const client = await clientFor(harness)
    await seedSession(harness, 'tiny-budget', (session) => { userTurn(session, 'header', 1) })
    const result = await client.callTool({
      name: 'events_read',
      arguments: { address: { kind: 'session', session_id: 'tiny-budget' }, after_seq: -1 },
    })
    // A short log's header fits, so this call succeeds; the bound is asserted on
    // sessions whose header block is genuinely too large.
    expect(result.isError ?? false).toBe(false)

    // The header is part of every page, so a page that delivers nothing is
    // bounded as well: an empty log, and a cursor already at the watermark.
    const wide = `/${'w'.repeat(6000)}`
    await seedWithCwd(harness, 'wide-header-events', wide, (session) => { userTurn(session, 'x', 1) })
    await seedWithCwd(harness, 'wide-header-empty', wide, () => {})
    const full = await failure(client, {
      address: { kind: 'session', session_id: 'wide-header-events' },
      after_seq: -1,
    })
    expect(full).toMatchObject({ code: 'mcp-control/result-too-large', details: {} })
    const empty = await failure(client, {
      address: { kind: 'session', session_id: 'wide-header-empty' },
      after_seq: -1,
    })
    expect(empty).toMatchObject({ code: 'mcp-control/result-too-large', details: {} })
    const atWatermark = await failure(client, {
      address: { kind: 'session', session_id: 'wide-header-events' },
      after_seq: 2,
    })
    expect(atWatermark).toMatchObject({ code: 'mcp-control/result-too-large', details: {} })
  })
})

describe('events_read cost at scale', () => {
  it('serves a far cursor of a 100k-event log inside one call budget', { timeout: 120_000 }, async () => {
    const harness = await boot({ config: { requestTimeoutMs: 25_000, maxEvents: 512 } })
    const client = await clientFor(harness)
    const count = 100_000
    const events: SessionEvent[] = []
    for (let index = 0; index < count; index += 1) {
      // One message every 500 events: the far-cursor case the point read must
      // still cover without walking pages backwards.
      if (index % 500 === 0) {
        events.push({
          type: 'user/message',
          seq: SessionSeq(index),
          time: 1_700_000_000_000 + index,
          data: createUserMessage({ content: [{ type: 'text', text: `message ${String(index)}` }], source: { kind: 'user' } }),
          surfaceOp: 'append',
        })
        continue
      }
      events.push({
        type: 'request/context',
        seq: SessionSeq(index),
        time: 1_700_000_000_000 + index,
        data: { provider: 'mock', model: `model-${String(index)}` },
      })
    }
    await seedSession(harness, 'large-log', () => events)

    const nativePage = vi.spyOn(harness.ctx.sessionController, 'page')
    const started = process.hrtime.bigint()
    const answer = await page(client, 'large-log', { after_seq: 99_000, max_events: 128 })
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    const heapMb = process.memoryUsage().heapUsed / (1024 * 1024)
    // Evidence for the plan's measurement requirement, printed on success only.
    console.log(`mcp-control events_read far cursor: ${elapsedMs.toFixed(1)}ms, heap ${heapMb.toFixed(1)}MB, native page calls ${String(nativePage.mock.calls.length)}`)
    expect(answer.head_seq).toBe(count - 1)
    expect((answer.events as unknown[]).length).toBe(128)
    expect((answer.next_seq as number)).toBe(99_000 + 128)
    expect(answer.has_more).toBe(true)
    expect(nativePage.mock.calls.length).toBe(1)
    expect(elapsedMs).toBeLessThan(20_000)
    nativePage.mockRestore()
  })

  it('serves a log whose open turn the native read repairs, adding nothing else', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    const stored = await seedSession(harness, 'open-turn', (session) => {
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'the turn never closed' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    })
    const answer = await page(client, 'open-turn', { after_seq: -1 })
    const served = answer.events as Array<{ type: string; seq: number; data: unknown }>
    expect(served.slice(0, stored.length)).toEqual(stored)
    expect(served.length).toBeGreaterThan(stored.length)
    for (const extra of served.slice(stored.length)) {
      expect(extra.type).toBe('turn/end')
      expect(extra.data).toEqual({ turn: 1, reason: { kind: 'interrupted' } })
    }
  })
})
