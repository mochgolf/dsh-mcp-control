/**
 * `turn_result`: the compact outcome of the turn that answered one prompt,
 * waited for within one bounded call, against the real Agent Loop, Session
 * Controller, and subagent runtime.
 */

import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Client } from '@modelcontextprotocol/client'
import { textResponse, toolCallResponse } from './support/mock-adapter.ts'
import { bootHarness, closeAll, connectClient, seedSession, startRootAgent, textJson, type Harness } from './harness.ts'

const harnesses: Harness[] = []
const clients: Client[] = []

afterEach(async () => {
  vi.restoreAllMocks()
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

async function turnResult(client: Client, sessionId: string, requestId: string, waitMs?: number): Promise<Record<string, unknown>> {
  return await call(client, 'turn_result', {
    address: { kind: 'session', session_id: sessionId },
    request_id: requestId,
    ...(waitMs === undefined ? {} : { wait_ms: waitMs }),
  })
}

/** Hold the first model call open until `release` is called; later calls answer from `answers`. */
function gatedModel(harness: Harness, first: string, answers: string[]): { release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  vi.spyOn(harness.adapter, 'stream').mockImplementation(async function* () {
    calls += 1
    if (calls === 1) {
      await gate
      yield* textResponse(first)
      return
    }
    yield* textResponse(answers.shift() ?? 'unexpected call')
  })
  return { release }
}

describe('turn_result', () => {
  it('returns the final answer of an ended turn', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({ script: [textResponse('the final answer')] })
    await call(client, 'session_start', { cwd: harness.workspace, prompt: 'answer', session_id: 'done', request_id: 'R1' })
    const result = await turnResult(client, 'done', 'R1')
    expect(result).toMatchObject({
      session_id: 'done',
      request_id: 'R1',
      state: 'ended',
      turn: 1,
      reason: { kind: 'completed' },
      final_message: 'the final answer',
      final_message_seq: expect.any(Number),
      diagnostics: [],
    })
  })

  it('waits for a running turn and returns as soon as it ends', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot()
    const model = gatedModel(harness, 'finished after a while', [])
    await call(client, 'session_start', { cwd: harness.workspace, prompt: 'work', session_id: 'slow', request_id: 'R1' })
    expect(await turnResult(client, 'slow', 'R1', 0)).toMatchObject({ state: 'running', agent_status: 'running', turn: 1 })

    setTimeout(() => { model.release() }, 300)
    const started = performance.now()
    const result = await turnResult(client, 'slow', 'R1', 10_000)
    expect(result).toMatchObject({ state: 'ended', final_message: 'finished after a while' })
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it('follows a prompt queued behind a running turn until its own turn ends', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot()
    const model = gatedModel(harness, 'answer to first', ['answer to queued'])
    await call(client, 'session_start', { cwd: harness.workspace, prompt: 'first', session_id: 'queued', request_id: 'R1' })
    await call(client, 'session_send', { session_id: 'queued', message: 'second', request_id: 'R2' })
    expect(await turnResult(client, 'queued', 'R2', 0)).toMatchObject({ state: 'queued', agent_status: 'running' })

    setTimeout(() => { model.release() }, 200)
    expect(await turnResult(client, 'queued', 'R2', 10_000)).toMatchObject({
      state: 'ended',
      turn: 2,
      final_message: 'answer to queued',
    })
    expect(await turnResult(client, 'queued', 'R1', 0)).toMatchObject({ state: 'ended', turn: 1, final_message: 'answer to first' })
  })

  it('reports a prompt stranded on an idle agent promptly instead of waiting out the call', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({ script: ['hang'] })
    await call(client, 'session_start', { cwd: harness.workspace, prompt: 'hold', session_id: 'stranded', request_id: 'R1' })
    await call(client, 'session_send', { session_id: 'stranded', message: 'queued', request_id: 'R2' })
    await call(client, 'session_cancel', { session_id: 'stranded' })
    await harness.ctx.agents.get(SessionId('stranded'))!.whenIdle()

    const started = performance.now()
    expect(await turnResult(client, 'stranded', 'R2', 10_000)).toMatchObject({ state: 'queued', agent_status: 'idle' })
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(await turnResult(client, 'stranded', 'R1', 0)).toMatchObject({ state: 'ended', reason: { kind: 'aborted' } })
  })

  it('returns as soon as the turn blocks on an approval only a human can give', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({ script: ['hang'] })
    await call(client, 'session_start', { cwd: harness.workspace, prompt: 'hold', session_id: 'asking', request_id: 'R1' })
    const session = harness.ctx.sessions.get(SessionId('asking'))!
    const append = session.append.bind(session) as (type: string, data: unknown) => void
    setTimeout(() => { append('approval/asked', { id: 'approval-1', toolName: 'bash', reason: 'write outside the workspace' }) }, 300)

    const started = performance.now()
    const result = await turnResult(client, 'asking', 'R1', 10_000)
    expect(result).toMatchObject({
      state: 'blocked_on_approval',
      agent_status: 'running',
      pending_approvals: [{ id: 'approval-1', tool_name: 'bash', reason: 'write outside the workspace' }],
    })
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it('counts the approvals it leaves out', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({ script: ['hang'] })
    await call(client, 'session_start', { cwd: harness.workspace, prompt: 'hold', session_id: 'many-asks', request_id: 'R1' })
    const session = harness.ctx.sessions.get(SessionId('many-asks'))!
    const append = session.append.bind(session) as (type: string, data: unknown) => void
    for (let index = 0; index < 23; index += 1) append('approval/asked', { id: `approval-${String(index)}`, toolName: 'bash' })
    const result = await turnResult(client, 'many-asks', 'R1', 0)
    expect(result).toMatchObject({ state: 'blocked_on_approval', pending_approvals_omitted: 3 })
    expect(result.pending_approvals).toHaveLength(20)
  })

  it('reports tool failures of the turn as compact diagnostics', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({
      script: [toolCallResponse('call-1', 'no_such_tool', { path: 'x' }), textResponse('recovered')],
    })
    await call(client, 'session_start', { cwd: harness.workspace, prompt: 'use a tool', session_id: 'tools', request_id: 'R1' })
    const result = await turnResult(client, 'tools', 'R1')
    expect(result).toMatchObject({ state: 'ended', final_message: 'recovered', reason: { kind: 'completed' } })
    const diagnostics = result.diagnostics as Array<{ seq: number; error: { name: string; code: string } }>
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.error).toMatchObject({ name: expect.any(String), code: expect.any(String) })
  })

  it('reports a prompt removed from the inbox before any turn ran it as discarded', { timeout: 60_000 }, async () => {
    const first = await bootHarness({ script: ['hang', 'hang'], retainRoots: true })
    harnesses.push(first)
    const firstClient = await connectClient(`${first.baseUrl}/mcp`)
    clients.push(firstClient)
    await call(firstClient, 'session_start', { cwd: first.workspace, prompt: 'hold', session_id: 'dropped', request_id: 'R1' })
    await call(firstClient, 'session_send', { session_id: 'dropped', message: 'cleared before it ran', request_id: 'R2' })
    await call(firstClient, 'session_cancel', { session_id: 'dropped', clear_queue: true })
    const agent = first.ctx.agents.get(SessionId('dropped'))!
    await agent.whenIdle()
    expect(await turnResult(firstClient, 'dropped', 'R2', 0)).toMatchObject({ state: 'discarded' })
    // R3 wakes the Agent into a turn that holds; R4 waits behind it until shutdown.
    await call(firstClient, 'session_send', { session_id: 'dropped', message: 'hold again', request_id: 'R3' })
    await vi.waitFor(() => { expect(agent.status).toBe('running') })
    await call(firstClient, 'session_send', { session_id: 'dropped', message: 'pending at shutdown', request_id: 'R4' })
    expect(await turnResult(firstClient, 'dropped', 'R4', 0)).toMatchObject({ state: 'queued' })
    await closeAll(clients.splice(clients.indexOf(firstClient), 1), harnesses.splice(harnesses.indexOf(first), 1))

    // Shutting the Agent down durably cancels what was still pending.
    const { client } = await boot({ workspace: first.workspace, persistenceRoot: first.persistenceRoot })
    try {
      expect(await turnResult(client, 'dropped', 'R4', 0)).toMatchObject({ state: 'discarded', agent_status: 'not_loaded' })
      expect(await turnResult(client, 'dropped', 'R1', 0)).toMatchObject({ state: 'ended', reason: { kind: 'aborted' } })
    } finally {
      rmSync(first.workspace, { recursive: true, force: true })
      rmSync(first.persistenceRoot, { recursive: true, force: true })
    }
  })

  it('tells a prompt claimed for a turn apart from one discarded unrun', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({ script: ['hang'] })
    await call(client, 'session_start', { cwd: harness.workspace, prompt: 'hold', session_id: 'window', request_id: 'R1' })
    const session = harness.ctx.sessions.get(SessionId('window'))!
    const append = session.append.bind(session) as (type: string, data: unknown) => void
    const prompt = (rpcId: string) => ({ content: [{ type: 'text', text: rpcId }], source: { kind: 'user', rpcId }, role: 'user', id: `message-${rpcId}` })
    // The loop claims a prompt with a removal that carries no outcome and records
    // its user/message only after preparing the step; a dropped prompt is marked canceled.
    append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [prompt('claimed')] })
    append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [prompt('dropped')] })
    append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
    expect(await turnResult(client, 'window', 'claimed', 0)).toMatchObject({ state: 'running', turn: 1 })
    expect(await turnResult(client, 'window', 'dropped', 0)).toMatchObject({ state: 'discarded' })
  })

  it('reports a prompt claimed by a turn that crashed before recording it as ended', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot()
    await seedSession(harness, 'crashed', (session) => {
      const append = session.append.bind(session) as (type: string, data: unknown, options?: unknown) => void
      append('turn/start', { turn: 1 })
      append('user/message', createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user', rpcId: 'R1' } as never }), { surfaceOp: 'append' })
      append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ content: [{ type: 'text', text: 'second' }], source: { kind: 'user', rpcId: 'R2' }, role: 'user', id: 'crashed-r2' }] })
      append('turn/start', { turn: 2 })
      append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    })
    // A cold read closes the orphaned turn as interrupted.
    expect(await turnResult(client, 'crashed', 'R2', 0)).toMatchObject({
      state: 'ended',
      turn: 2,
      reason: { kind: 'interrupted' },
      final_message: null,
      agent_status: 'not_loaded',
    })
  })

  it('answers not_found for a request id neither the log nor the inbox holds', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({ script: [textResponse('done')] })
    await call(client, 'session_start', { cwd: harness.workspace, prompt: 'answer', session_id: 'known', request_id: 'R1' })
    expect(await turnResult(client, 'known', 'never-sent', 5_000)).toMatchObject({ state: 'not_found', diagnostics: [] })
    const missing = await client.callTool({
      name: 'turn_result',
      arguments: { address: { kind: 'session', session_id: 'no-such-session' }, request_id: 'R1' },
    })
    expect((textJson(missing).error as { code?: string }).code).toBe('session/not-found')
  })

  it('reads the result of a child_send through the subagent address', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot()
    // The parent also runs a turn when its child settles, so replies follow the
    // prompt rather than the order in which the two Agents call the model.
    vi.spyOn(harness.adapter, 'stream').mockImplementation(async function* (options) {
      const asked = JSON.stringify(options.messages.at(-1) ?? null)
      yield* textResponse(asked.includes('continue') ? 'child answer' : 'settled')
    })
    const parent = await startRootAgent(harness, 'root-tree')
    const started = await harness.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'worker',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
      signal: new AbortController().signal,
    })
    await harness.ctx.agents.get(started.childId)?.whenIdle()
    await call(client, 'child_send', {
      parent_session_id: parent.id,
      child_session_id: started.childId,
      message: 'continue',
      request_id: 'child-R1',
    })
    const result = await call(client, 'turn_result', {
      address: { kind: 'subagent', parent_session_id: parent.id, child_session_id: started.childId, mode: 'continuable' },
      request_id: 'child-R1',
    })
    expect(result).toMatchObject({
      parent_session_id: parent.id,
      child_session_id: started.childId,
      state: 'ended',
      reason: { kind: 'completed' },
      final_message: 'child answer',
    })
  })

  it('finds a prompt far back in a long cold log through doubling backward pages', { timeout: 60_000 }, async () => {
    const { harness, client } = await boot()
    const turns = 300
    await seedSession(harness, 'long-log', (session) => {
      for (let turn = 1; turn <= turns; turn += 1) {
        session.append('turn/start', { turn })
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: `prompt ${String(turn)}` }],
          source: { kind: 'user', rpcId: `R${String(turn)}` } as never,
        }), { surfaceOp: 'append' })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
    })
    const page = vi.spyOn(harness.ctx.sessionController, 'page')
    expect(await turnResult(client, 'long-log', 'R1', 0)).toMatchObject({ state: 'ended', turn: 1, agent_status: 'not_loaded', final_message: null })
    // 300 messages from the head: pages of 64, 128, and 256 messages reach the first turn.
    expect(page.mock.calls.map(([request]) => request.maxMessages)).toEqual([64, 128, 256])
    page.mockClear()
    expect(await turnResult(client, 'long-log', `R${String(turns)}`, 0)).toMatchObject({ state: 'ended', turn: turns })
    expect(page).toHaveBeenCalledTimes(1)
    expect(harness.ctx.agents.get(SessionId('long-log'))).toBeUndefined()
  })

  it('shortens only the final message when the result would exceed the budget', { timeout: 60_000 }, async () => {
    const answer = `${'汉字🙂'.repeat(4_000)}END`
    const { harness, client } = await boot({
      script: [textResponse(answer)],
      config: { maxToolResultBytes: 8192, defaultChunkBytes: 2048 },
    })
    await call(client, 'session_start', { cwd: harness.workspace, prompt: `${'汉字🙂'.repeat(6_000)}END`, session_id: 'big', request_id: 'R1' })
    const raw = await client.callTool({ name: 'turn_result', arguments: { address: { kind: 'session', session_id: 'big' }, request_id: 'R1' } })
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThanOrEqual(8192)
    const result = textJson(raw)
    expect(result).toMatchObject({ state: 'ended', final_message_truncated: true, final_message_seq: expect.any(Number) })
    const text = result.final_message as string
    expect(answer.startsWith(text)).toBe(true)
    expect(text.length).toBeGreaterThan(0)
    // No surrogate pair is cut in half.
    expect(Array.from(text).join('')).toBe(text)
    expect(text.endsWith('\ud83d')).toBe(false)
  })

  it('ends its wait inside a short request timeout and answers instead of timing out', { timeout: 30_000 }, async () => {
    const { harness, client } = await boot({ script: ['hang'], config: { requestTimeoutMs: 1_000 } })
    await call(client, 'session_start', { cwd: harness.workspace, prompt: 'hold', session_id: 'long', request_id: 'R1' })
    const started = performance.now()
    expect(await turnResult(client, 'long', 'R1')).toMatchObject({ state: 'running' })
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
