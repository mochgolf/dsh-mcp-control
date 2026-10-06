/**
 * `session_status` and `session_cancel` with `clear_queue`: the states a caller
 * polling a turn cannot tell apart from the log alone — a turn still computing,
 * a prompt stranded in the inbox after a cancel, and a turn blocked on a human
 * approval — against the real Agent Loop and Session Controller.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Client } from '@modelcontextprotocol/client'
import { textResponse } from './support/mock-adapter.ts'
import { bootHarness, closeAll, connectClient, seedSession, textJson, type Harness } from './harness.ts'

const harnesses: Harness[] = []
const clients: Client[] = []

afterEach(async () => {
  await closeAll(clients.splice(0), harnesses.splice(0))
})

async function boot(options: Parameters<typeof bootHarness>[0] = {}): Promise<{ harness: Harness; client: Client }> {
  const harness = await bootHarness(options)
  harnesses.push(harness)
  const client = await connectClient(`${harness.baseUrl}/mcp`)
  clients.push(client)
  return { harness, client }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true) throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent)}`)
  return textJson(result)
}

async function status(client: Client, sessionId: string): Promise<Record<string, unknown>> {
  return await call(client, 'session_status', { address: { kind: 'session', session_id: sessionId } })
}

/** The client request ids of the prompts a Session's log recorded, in order. */
async function recordedRequests(harness: Harness, sessionId: string): Promise<string[]> {
  const events = (await harness.ctx.sessionController.inspect(SessionId(sessionId))).events
  return events
    .filter(event => event.type === 'user/message')
    .map(event => (event.data as { source?: { rpcId?: string } }).source?.rpcId)
    .filter((rpcId): rpcId is string => rpcId !== undefined)
}

describe('session_status', () => {
  it('reports a running turn and the prompts queued behind it', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({ script: ['hang', textResponse('later')] })
    await call(client, 'session_start', { cwd: harness.workspace, prompt: 'hold', session_id: 'busy', request_id: 'R1' })
    await call(client, 'session_send', { session_id: 'busy', message: 'queued behind the turn', request_id: 'R2' })
    await call(client, 'session_send', { session_id: 'busy', message: 'steer the turn', delivery: 'steer', request_id: 'R3' })

    const busy = await status(client, 'busy')
    expect(busy).toMatchObject({
      session_id: 'busy',
      agent_status: 'running',
      turn: { turn: 1, open: true },
      pending_approvals: [],
    })
    expect(busy.queue).toEqual([
      { item_id: expect.any(String), delivery: 'steer', request_id: 'R3', preview: 'steer the turn' },
      { item_id: expect.any(String), delivery: 'queue', request_id: 'R2', preview: 'queued behind the turn' },
    ])
  })

  it('shows a prompt stranded in the inbox after a cancel', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({ script: ['hang', textResponse('never claimed')] })
    await call(client, 'session_start', { cwd: harness.workspace, prompt: 'hold', session_id: 'stranded', request_id: 'R1' })
    await call(client, 'session_send', { session_id: 'stranded', message: 'queued', request_id: 'R2' })
    await call(client, 'session_cancel', { session_id: 'stranded' })
    await harness.ctx.agents.get(SessionId('stranded'))!.whenIdle()

    expect(await status(client, 'stranded')).toMatchObject({
      agent_status: 'idle',
      turn: { turn: 1, open: false, reason: { kind: 'aborted' } },
      queue: [{ delivery: 'queue', request_id: 'R2' }],
      pending_approvals: [],
    })
  })

  it('lists the approvals an open turn waits on until they are decided', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({ script: ['hang'] })
    await call(client, 'session_start', { cwd: harness.workspace, prompt: 'hold', session_id: 'asking', request_id: 'R1' })
    const session = harness.ctx.sessions.get(SessionId('asking'))!
    // The approval service records exactly this audit pair inside the open turn.
    const append = session.append.bind(session) as (type: string, data: unknown) => void
    append('approval/asked', { id: 'approval-1', toolName: 'bash', reason: 'write outside the workspace' })
    append('approval/asked', { id: 'approval-2', toolName: 'fs.write' })

    expect(await status(client, 'asking')).toMatchObject({
      agent_status: 'running',
      turn: { open: true },
      pending_approvals: [
        { id: 'approval-1', tool_name: 'bash', reason: 'write outside the workspace' },
        { id: 'approval-2', tool_name: 'fs.write' },
      ],
    })
    append('approval/decided', { id: 'approval-1', outcome: 'allowed-once' })
    const after = await status(client, 'asking')
    expect(after.pending_approvals).toEqual([{ id: 'approval-2', seq: expect.any(Number), tool_name: 'fs.write' }])
  })

  it('bounds the approvals it lists and counts the rest', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({ script: ['hang'] })
    await call(client, 'session_start', { cwd: harness.workspace, prompt: 'hold', session_id: 'many', request_id: 'R1' })
    const session = harness.ctx.sessions.get(SessionId('many'))!
    const append = session.append.bind(session) as (type: string, data: unknown) => void
    for (let index = 0; index < 25; index += 1) {
      append('approval/asked', { id: `approval-${String(index)}`, toolName: 'bash', reason: 'r'.repeat(2_000) })
    }
    const listed = await status(client, 'many')
    const approvals = listed.pending_approvals as Array<{ id: string; reason: string }>
    expect(approvals).toHaveLength(20)
    expect(approvals[0]?.id).toBe('approval-0')
    expect(approvals.every(approval => approval.reason.length === 500)).toBe(true)
    expect(listed.pending_approvals_omitted).toBe(5)
  })

  it('reports prompts left in the durable inbox of a Session whose Agent is not loaded', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot()
    // A process that exits without shutting its Agent down leaves the pending
    // insertion in the log with no cancellation after it.
    await seedSession(harness, 'parked', (session) => {
      const append = session.append.bind(session) as (type: string, data: unknown, options?: unknown) => void
      append('turn/start', { turn: 1 })
      append('user/message', createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user', rpcId: 'R1' } as never }), { surfaceOp: 'append' })
      append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      append('agent/inbox/spliced', {
        target: 'next-turn',
        start: 0,
        inserted: [{ content: [{ type: 'text', text: 'still queued' }], source: { kind: 'user', rpcId: 'R2' }, role: 'user', id: 'parked-r2' }],
      })
    })
    expect(await status(client, 'parked')).toMatchObject({
      agent_status: 'not_loaded',
      queue: [{ item_id: 'parked-r2', delivery: 'queue', request_id: 'R2', preview: 'still queued' }],
    })
    expect(await call(client, 'turn_result', { address: { kind: 'session', session_id: 'parked' }, request_id: 'R2' }))
      .toMatchObject({ state: 'queued', agent_status: 'not_loaded' })
    expect(harness.ctx.agents.get(SessionId('parked'))).toBeUndefined()
  })

  it('reports a settled turn, and refuses an unknown Session without loading an Agent', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({ script: [textResponse('done')] })
    await call(client, 'session_start', { cwd: harness.workspace, prompt: 'finish', session_id: 'settled' })
    await harness.ctx.agents.get(SessionId('settled'))!.whenIdle()
    expect(await status(client, 'settled')).toMatchObject({
      agent_status: 'idle',
      turn: { turn: 1, open: false, reason: { kind: 'completed' } },
      queue: [],
    })
    const missing = await client.callTool({ name: 'session_status', arguments: { address: { kind: 'session', session_id: 'never-created' } } })
    expect(missing.isError).toBe(true)
    expect((textJson(missing).error as { code?: string }).code).toBe('session/not-found')
    expect(harness.ctx.agents.get(SessionId('never-created'))).toBeUndefined()
  })
})

describe('session_cancel clear_queue', () => {
  it('removes queued and steering prompts so nothing sent before the cancel runs afterwards', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({ script: ['hang', textResponse('only the new task')] })
    await call(client, 'session_start', { cwd: harness.workspace, prompt: 'hold', session_id: 'cleared', request_id: 'R1' })
    await call(client, 'session_send', { session_id: 'cleared', message: 'cancelled intent', request_id: 'R2' })
    await call(client, 'session_send', { session_id: 'cleared', message: 'cancelled steer', delivery: 'steer', request_id: 'R3' })

    const receipt = await call(client, 'session_cancel', { session_id: 'cleared', clear_queue: true })
    expect(receipt).toMatchObject({ session_id: 'cleared', accepted: true })
    expect(receipt.removed_queue_items).toEqual([
      { item_id: expect.any(String), request_id: 'R3' },
      { item_id: expect.any(String), request_id: 'R2' },
    ])
    const agent = harness.ctx.agents.get(SessionId('cleared'))!
    await agent.whenIdle()
    expect((await status(client, 'cleared')).queue).toEqual([])

    await call(client, 'session_send', { session_id: 'cleared', message: 'new task', request_id: 'R4' })
    await agent.whenIdle()
    expect(await recordedRequests(harness, 'cleared')).toEqual(['R1', 'R4'])
  })

  it('names the prompts it already removed when the interrupt itself fails', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({ script: ['hang'] })
    await call(client, 'session_start', { cwd: harness.workspace, prompt: 'hold', session_id: 'half', request_id: 'R1' })
    await call(client, 'session_send', { session_id: 'half', message: 'queued', request_id: 'R2' })
    vi.spyOn(harness.ctx.sessionController, 'cancel').mockImplementation(() => {
      throw Object.assign(new Error('session "half" not found (not attached)'), {
        isDSHRemoteError: true,
        code: 'session/not-found',
        details: { sessionId: 'half' },
      })
    })
    const result = await client.callTool({ name: 'session_cancel', arguments: { session_id: 'half', clear_queue: true } })
    expect(result.isError).toBe(true)
    expect(textJson(result).error).toMatchObject({
      code: 'session/not-found',
      details: { session_id: 'half', removed_queue_items: [{ item_id: expect.any(String), request_id: 'R2' }], removed_queue_item_count: 1 },
    })
  })

  it('keeps the inbox by default, and the stranded prompt runs when a later prompt wakes the agent', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({ script: ['hang', textResponse('stranded turn'), textResponse('new turn')] })
    await call(client, 'session_start', { cwd: harness.workspace, prompt: 'hold', session_id: 'kept', request_id: 'R1' })
    await call(client, 'session_send', { session_id: 'kept', message: 'cancelled intent', request_id: 'R2' })
    expect(await call(client, 'session_cancel', { session_id: 'kept' })).toEqual({ session_id: 'kept', accepted: true })
    const agent = harness.ctx.agents.get(SessionId('kept'))!
    await agent.whenIdle()
    await call(client, 'session_send', { session_id: 'kept', message: 'new task', request_id: 'R3' })
    await expect.poll(async () => await recordedRequests(harness, 'kept'), { timeout: 5_000 }).toEqual(['R1', 'R2', 'R3'])
  })
})
