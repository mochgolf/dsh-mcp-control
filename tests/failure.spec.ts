/**
 * P5 failure acceptance, keyless and in-process against the real composition:
 * a plugin reload that must not interrupt a live root, an MCP client reconnect
 * while the root is running, and the cold-tree cycle — durable reads still work,
 * direct child control is refused for a cold parent, and it works again once the
 * parent is resumed through the native path.
 *
 * The third class boots a second composition over the first one's workspace and
 * JSONL persistence root, which is the in-process equivalent of stopping and
 * restarting the DSH process: only committed durable data survives. A final
 * case checks that one refusing client cannot strand the other cases' listeners
 * and roots.
 */

import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { Client } from '@modelcontextprotocol/client'
import { textResponse } from './support/mock-adapter.ts'
import * as McpControl from '../src/index.ts'
import {
  bootHarness,
  closeAll,
  connectClient,
  controlConfig,
  startRootAgent,
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

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true) throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent)}`)
  return textJson(result)
}

async function callFailure(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError, `${name} unexpectedly succeeded`).toBe(true)
  return textJson(result).error as Record<string, unknown>
}

describe('plugin reload with a live root', () => {
  it('leaves the running Agent, its session, and its cursor untouched', { timeout: 60_000 }, async () => {
    const harness = await boot({ script: ['hang', textResponse('after the reload')], mountControl: false })
    const mounted = await harness.ctx.plugin(McpControl, controlConfig())
    const first = await clientFor(harness)
    const started = await call(first, 'session_start', {
      cwd: harness.workspace,
      prompt: 'hold the turn across the reload',
      session_id: 'reload-root',
      request_id: 'reload-request',
    })
    expect(started.accepted).toBe(true)
    const agent = harness.ctx.agents.get(SessionId('reload-root'))
    expect(agent?.status).toBe('running')
    const before = await call(first, 'events_read', {
      address: { kind: 'session', session_id: 'reload-root' },
      after_seq: -1,
      max_events: 2,
    })
    await first.close()

    // Unload and re-register the endpoint while the model call is still open.
    await mounted.dispose()
    await harness.ctx.plugin(McpControl, controlConfig())

    expect(harness.ctx.agents.get(SessionId('reload-root'))).toBe(agent)
    expect(agent?.status).toBe('running')

    const second = await clientFor(harness)
    const after = await call(second, 'events_read', {
      address: { kind: 'session', session_id: 'reload-root' },
      after_seq: before.next_seq,
      max_events: 8,
    })
    const seen = [
      ...(before.events as Array<{ seq: number }>).map(event => event.seq),
      ...(after.events as Array<{ seq: number }>).map(event => event.seq),
    ]
    expect(new Set(seen).size).toBe(seen.length)
    expect((after.head_seq as number)).toBeGreaterThanOrEqual(before.head_seq as number)

    // The reloaded endpoint still controls the same live root.
    const sent = await call(second, 'session_send', {
      session_id: 'reload-root',
      message: 'after the reload',
      request_id: 'reload-request-2',
    })
    expect(sent.accepted).toBe(true)
    const cancelled = await call(second, 'session_cancel', { session_id: 'reload-root' })
    expect(cancelled.accepted).toBe(true)
    await agent!.whenIdle()
  })
})

describe('MCP client reconnect while the root runs', () => {
  it('resumes from the previous cursor and keeps controlling the same turn', { timeout: 60_000 }, async () => {
    const harness = await boot({ script: ['hang', textResponse('after the reconnect')] })
    const first = await clientFor(harness)
    await call(first, 'session_start', {
      cwd: harness.workspace,
      prompt: 'hold the turn across the reconnect',
      session_id: 'reconnect-root',
    })
    const page = await call(first, 'events_read', {
      address: { kind: 'session', session_id: 'reconnect-root' },
      after_seq: -1,
      max_events: 1,
    })
    const agent = harness.ctx.agents.get(SessionId('reconnect-root'))
    // The client disappears mid-turn: a dropped connection, not a cancellation.
    await first.close()

    const second = await clientFor(harness)
    expect(agent?.status).toBe('running')
    const resumed = await call(second, 'events_read', {
      address: { kind: 'session', session_id: 'reconnect-root' },
      after_seq: page.next_seq,
      max_events: 8,
    })
    const firstSeqs = (page.events as Array<{ seq: number }>).map(event => event.seq)
    const resumedSeqs = (resumed.events as Array<{ seq: number }>).map(event => event.seq)
    expect(resumedSeqs.length).toBeGreaterThan(0)
    expect(resumedSeqs[0]).toBe((firstSeqs.at(-1) ?? -1) + 1)

    const steered = await call(second, 'session_send', {
      session_id: 'reconnect-root',
      message: 'steered after reconnecting',
      delivery: 'steer',
      request_id: 'reconnect-request',
    })
    expect(steered.accepted).toBe(true)
    expect(agent?.inbox.nextStep.map(message => message.content[0])).toEqual([
      { type: 'text', text: 'steered after reconnecting' },
    ])
    await call(second, 'session_cancel', { session_id: 'reconnect-root' })
    await agent!.whenIdle()
  })
})

describe('cold durable tree and parent recovery', () => {
  it('reads history cold, refuses a cold-parent child send, then controls it after the native resume', { timeout: 120_000 }, async () => {
    // First instance: create the root, let it settle, and create a native
    // continuable child below it.
    const first = await boot({ script: [textResponse('root settled'), textResponse('child settled')], retainRoots: true })
    const firstClient = await clientFor(first)
    const parent = await startRootAgent(first, 'restart-root')
    const started = await first.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'worker',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
      signal: new AbortController().signal,
    })
    const childId = started.childId
    await parent.whenIdle()
    const durable = await call(firstClient, 'events_read', {
      address: { kind: 'session', session_id: parent.id },
      after_seq: -1,
      max_events: 64,
    })
    expect((durable.events as unknown[]).length).toBeGreaterThan(0)
    await firstClient.close()
    // Everything cools: the whole process-equivalent instance goes away.
    await first.dispose()
    harnesses.splice(harnesses.indexOf(first), 1)

    const second = await boot({
      script: [textResponse('parent resumed'), textResponse('child continued')],
      workspace: first.workspace,
      persistenceRoot: first.persistenceRoot,
    })
    const client = await clientFor(second)
    expect(second.ctx.agents.get(parent.id)).toBeUndefined()

    // Durable history and tree are still readable while everything is cold.
    const coldHistory = await call(client, 'events_read', {
      address: { kind: 'session', session_id: parent.id },
      after_seq: -1,
      max_events: 64,
    })
    expect(coldHistory.events).toEqual(durable.events)
    const coldTree = await call(client, 'agents_list', { root_session_id: parent.id })
    const entries = coldTree.entries as Array<Record<string, unknown>>
    expect(entries.map(entry => entry.id)).toContain(childId)

    // A cold parent is refused, never silently resumed by the endpoint.
    const refused = await callFailure(client, 'child_send', {
      parent_session_id: parent.id,
      child_session_id: childId,
      message: 'while the parent is cold',
    })
    expect(refused).toMatchObject({ code: 'subagent/parent-unavailable' })
    expect(second.ctx.agents.get(parent.id)).toBeUndefined()

    // The native resume path brings the parent back, and control works again.
    const resumed = await call(client, 'session_send', {
      session_id: parent.id,
      message: 'resume the parent',
      request_id: 'resume-request',
    })
    expect(resumed.accepted).toBe(true)
    const live = second.ctx.agents.get(parent.id)
    expect(live).toBeDefined()
    const delivered = await call(client, 'child_send', {
      parent_session_id: parent.id,
      child_session_id: childId,
      message: 'continue after the resume',
      request_id: 'child-after-resume',
    })
    expect(delivered.accepted).toBe(true)
    expect(String(delivered.message_id)).not.toBe('')
  })

  it('keeps the durable session format readable across the instance boundary', { timeout: 60_000 }, async () => {
    const first = await boot({ script: [textResponse('settled')], retainRoots: true })
    const client = await clientFor(first)
    await call(client, 'session_start', {
      cwd: first.workspace,
      prompt: 'durable across restart',
      session_id: 'restart-format',
    })
    await first.ctx.agents.get(SessionId('restart-format'))!.whenIdle()
    await client.close()
    const header = first.ctx.sessions.get(SessionId('restart-format'))?.header
    expect(header?.version).toBe(SESSION_FORMAT_VERSION)
    await first.dispose()
    harnesses.splice(harnesses.indexOf(first), 1)

    const second = await boot({
      script: [textResponse('unused')],
      workspace: first.workspace,
      persistenceRoot: first.persistenceRoot,
    })
    const reused = await clientFor(second)
    const page = await call(reused, 'events_read', {
      address: { kind: 'session', session_id: 'restart-format' },
      after_seq: -1,
    })
    expect(page.header).toMatchObject({ version: SESSION_FORMAT_VERSION, id: 'restart-format' })
  })
})

describe('case teardown', () => {
  it('releases the composition although a client close rejects', { timeout: 30_000 }, async () => {
    const harness = await boot({ mountControl: false })
    const closed: string[] = []
    const refusing = {
      close: async () => {
        closed.push('refusing')
        throw new Error('client close refused')
      },
    } as unknown as Client
    const healthy = { close: async () => { closed.push('healthy') } } as unknown as Client
    const outcome = await closeAll([refusing, healthy], [harness]).then(
      () => 'resolved' as const,
      (error: unknown) => error,
    )
    // A first rejection must not skip the disposal that owns the listener and
    // the temporary roots.
    expect(existsSync(harness.workspace)).toBe(false)
    expect(closed.sort()).toEqual(['healthy', 'refusing'])
    expect(outcome).toBeInstanceOf(AggregateError)
    expect((outcome as Error).message).toBe('mcp-control test teardown failed')
  })
})
