/**
 * P2: the six native control tools against the real Agent Loop, Session
 * Controller and subagent runtime. Acceptance is observed causally — a scripted
 * model call held open proves the endpoint answered before the turn finished —
 * and every refusal is produced by the real native implementation.
 */

import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Client } from '@modelcontextprotocol/client'
import { isFullyQualifiedPath } from '../src/paths.ts'
import { derivedSessionId } from '../src/tools.ts'
import { textResponse } from './support/mock-adapter.ts'
import {
  bootHarness,
  closeAll,
  connectClient,
  startRootAgent,
  textJson,
  type Harness,
} from './harness.ts'

/** Durable child identity used by the interrupt-mapping case. */
const ChildId = SessionId('child-0000-0000-0000-00000000')

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

/** Connect a client and register it for teardown. */
async function clientFor(harness: Harness): Promise<Client> {
  const client = await connectClient(`${harness.baseUrl}/mcp`)
  clients.push(client)
  return client
}

/** Call one tool and return its structured content, asserting success. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true) throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent)}`)
  return textJson(result)
}

/** Call one tool and return its structured failure. */
async function callFailure(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError, `${name} unexpectedly succeeded`).toBe(true)
  return textJson(result).error as Record<string, unknown>
}

/** Whether the SDK refused the call as invalid input, before any DSH service ran. */
function inputRefused(result: { isError?: boolean | undefined; content?: unknown }): boolean {
  if (result.isError !== true) return false
  const [first] = result.content as Array<{ type?: string; text?: string }>
  return first?.type === 'text' && typeof first.text === 'string' && first.text.startsWith('Input validation error')
}

/** Durable events of one session, read through the controller's cold-safe inspection. */
async function eventsOf(harness: Harness, sessionId: string) {
  return (await harness.ctx.sessionController.inspect(SessionId(sessionId))).events
}

/** The client-minted request identity a durable user message carries, when it has one. */
function rpcIdOf(event: { type: string; data: unknown }): string | undefined {
  return (event.data as { source?: { rpcId?: string } }).source?.rpcId
}

describe('session_start', () => {
  it('attaches an exact registered workspace and keeps other directories ungrouped', { timeout: 30_000 }, async () => {
    const harness = await boot({
      registerWorkspace: true,
      script: [textResponse('grouped'), textResponse('ungrouped'), textResponse('unresolved')],
    })
    const client = await clientFor(harness)
    const create = vi.spyOn(harness.ctx.sessionController, 'create')
    const workspace = harness.ctx.workspaceRegistry.list()[0]
    if (workspace === undefined) throw new Error('the registered workspace is missing')

    const grouped = await call(client, 'session_start', {
      cwd: harness.workspace,
      prompt: 'group this session',
      session_id: 'root-grouped',
    })
    const ungrouped = await call(client, 'session_start', {
      cwd: harness.persistenceRoot,
      prompt: 'leave this session ungrouped',
      session_id: 'root-ungrouped',
    })
    const unresolved = join(harness.workspace, 'unresolved')
    mkdirSync(unresolved)
    vi.spyOn(harness.ctx.workspaceRegistry, 'resolveByPath').mockRejectedValueOnce(
      Object.assign(new Error('registry lookup failed'), { code: 'EACCES' }),
    )
    await call(client, 'session_start', {
      cwd: unresolved,
      prompt: 'retain cwd creation',
      session_id: 'root-unresolved',
    })

    expect(create.mock.calls[0]?.[0]).toMatchObject({ workspaceId: workspace.id, sessionId: 'root-grouped' })
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('cwd')
    expect(create.mock.calls[1]?.[0]).toMatchObject({ cwd: harness.persistenceRoot, sessionId: 'root-ungrouped' })
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('workspaceId')
    expect(create.mock.calls[2]?.[0]).toMatchObject({ cwd: unresolved, sessionId: 'root-unresolved' })
    expect(workspace.sessionIds).toEqual([SessionId('root-grouped')])
    expect(grouped).toMatchObject({
      cwd: harness.workspace,
      workspace: { id: workspace.id, title: workspace.title },
      agent_preset: null,
      permission_preset: 'workspace-write',
    })
    expect(ungrouped).toMatchObject({
      cwd: harness.persistenceRoot,
      workspace: null,
      agent_preset: null,
      permission_preset: 'workspace-write',
    })
  })

  it('applies a native permission preset before the first prompt', { timeout: 30_000 }, async () => {
    const harness = await boot({ script: [textResponse('read only')] })
    const client = await clientFor(harness)
    const set = vi.spyOn(harness.ctx.permissionPresets, 'set')
    const prompt = vi.spyOn(harness.ctx.sessionController, 'prompt')
    const started = await call(client, 'session_start', {
      cwd: harness.workspace,
      prompt: 'inspect without writing',
      permission_preset: 'read-only',
      session_id: 'root-read-only',
    })
    const session = harness.ctx.sessions.get(SessionId('root-read-only'))
    if (session === undefined) throw new Error('the read-only session is missing')

    expect(started.permission_preset).toBe('read-only')
    expect(harness.ctx.permissionPresets.current(session)).toBe('read-only')
    expect(set).toHaveBeenCalledWith(session, 'read-only')
    expect(set.mock.invocationCallOrder[0]).toBeLessThan(prompt.mock.invocationCallOrder[0] ?? 0)
  })

  it('reports a permission-stage failure without submitting the prompt', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    vi.spyOn(harness.ctx.permissionPresets, 'set').mockImplementationOnce(() => {
      throw new Error('permission write failed')
    })
    const prompt = vi.spyOn(harness.ctx.sessionController, 'prompt')
    const failure = await callFailure(client, 'session_start', {
      cwd: harness.workspace,
      prompt: 'must not run',
      permission_preset: 'read-only',
      session_id: 'root-permission-failure',
      request_id: 'permission-failure',
    })

    expect(failure).toMatchObject({
      code: 'mcp-control/internal',
      details: {
        session_id: 'root-permission-failure',
        request_id: 'permission-failure',
        stage: 'permission',
      },
    })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('answers with a receipt while the turn is still running', { timeout: 30_000 }, async () => {
    const harness = await boot({ script: ['hang', textResponse('later')] })
    const client = await clientFor(harness)
    const started = await call(client, 'session_start', {
      cwd: harness.workspace,
      prompt: 'start the turn',
      session_id: 'root-receipt',
      request_id: 'request-1',
    })
    expect(started).toMatchObject({ session_id: 'root-receipt', request_id: 'request-1', accepted: true })
    // The scripted model call is still held open, so the receipt cannot have
    // waited for the turn to finish.
    expect(harness.ctx.agents.get(SessionId('root-receipt'))?.status).toBe('running')
    const messages = (await eventsOf(harness, 'root-receipt')).filter(event => event.type === 'user/message')
    expect(messages).toHaveLength(1)
  })

  it('accepts only fully qualified working directories under the Workspace Registry rule', () => {
    // Both platform rules are pinned here, so the Windows refusals are proved on every host.
    for (const path of ['/repo', '/']) expect(isFullyQualifiedPath(path, 'linux'), path).toBe(true)
    for (const path of ['relative/repo', './repo', 'C:\\repo']) expect(isFullyQualifiedPath(path, 'linux'), path).toBe(false)
    for (const path of ['C:\\repo', 'C:/repo', 'C:\\', '\\\\server\\share\\repo', '\\\\?\\C:\\repo']) {
      expect(isFullyQualifiedPath(path, 'win32'), path).toBe(true)
    }
    // Root-relative and drive-relative spellings resolve against the DSH process's current drive.
    for (const path of ['\\repo', '/home/me/repo', '/mnt/c/repo', 'C:repo', 'relative\\repo']) {
      expect(isFullyQualifiedPath(path, 'win32'), path).toBe(false)
    }
  })

  it('refuses a working directory that is not fully qualified on this platform before touching DSH', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    const create = vi.spyOn(harness.ctx.sessionController, 'create')
    const refused = ['relative/repo', './repo', ...(process.platform === 'win32' ? ['\\repo', '/repo', 'C:repo'] : [])]
    for (const cwd of refused) {
      const result = await client.callTool({ name: 'session_start', arguments: { cwd, prompt: 'path probe' } })
      expect(inputRefused(result), `cwd ${JSON.stringify(cwd)}`).toBe(true)
    }
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses a missing working directory instead of letting DSH create it', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    const create = vi.spyOn(harness.ctx.sessionController, 'create')
    const missing = `${harness.workspace}-typo`
    const stale = join(harness.workspace, 'removed-worktree', 'repo')
    for (const cwd of [missing, stale]) {
      const failure = await callFailure(client, 'session_start', { cwd, prompt: 'edit the repo', request_id: 'missing-cwd' })
      expect(failure, cwd).toMatchObject({
        code: 'mcp-control/cwd-not-found',
        details: { cwd, request_id: 'missing-cwd', stage: 'cwd' },
      })
      expect(existsSync(cwd), cwd).toBe(false)
    }
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses a working directory that is a file', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    const file = join(harness.workspace, 'notes.txt')
    writeFileSync(file, 'not a directory')
    const failure = await callFailure(client, 'session_start', { cwd: file, prompt: 'x' })
    expect(failure).toMatchObject({ code: 'mcp-control/cwd-not-directory', details: { cwd: file, stage: 'cwd' } })
    const below = await callFailure(client, 'session_start', { cwd: join(file, 'below'), prompt: 'x' })
    expect(below.code).toBe('mcp-control/cwd-not-found')
  })

  it('names the Session identity when the create outlives its deadline', { timeout: 30_000 }, async () => {
    const harness = await boot({ script: [textResponse('late')], config: { requestTimeoutMs: 50 } })
    const client = await clientFor(harness)
    const real = harness.ctx.sessionController.create.bind(harness.ctx.sessionController)
    let attempted: string | undefined
    vi.spyOn(harness.ctx.sessionController, 'create').mockImplementation(async (request) => {
      attempted = request.sessionId
      // The create keeps running after the caller's deadline, so it lands in
      // DSH while the caller holds nothing but this failure.
      await new Promise(resolve => setTimeout(resolve, 200))
      return await real(request)
    })
    const failure = await callFailure(client, 'session_start', {
      cwd: harness.workspace,
      prompt: 'the create outlives the deadline',
      request_id: 'timeout-create',
    })
    expect(failure).toMatchObject({
      code: 'mcp-control/request-timeout',
      details: { request_id: 'timeout-create', stage: 'create', receipt: 'unknown' },
    })
    const minted = (failure.details as { session_id?: unknown }).session_id
    if (typeof minted !== 'string') throw new Error('the create failure reported no session_id')
    expect(minted).toMatch(/^session-[\da-f-]{36}$/u)
    // The identity was chosen before the call, so the reported id is exactly the
    // one DSH is creating: a retry can adopt it instead of starting a second.
    expect(attempted).toBe(minted)
    await vi.waitFor(() => { expect(harness.ctx.sessions.get(SessionId(minted))).toBeDefined() })
  })

  it('derives one Session from request_id, cwd, and prompt when no session_id is supplied', { timeout: 30_000 }, async () => {
    const harness = await boot({ script: [textResponse('only once'), textResponse('another task')] })
    const client = await clientFor(harness)
    const args = { cwd: harness.workspace, prompt: 'do the task', request_id: 'idempotent-start' }
    const first = await call(client, 'session_start', args)
    const retry = await call(client, 'session_start', args)
    expect(first.session_id).toBe(derivedSessionId('idempotent-start', realpathSync(harness.workspace), 'do the task'))
    expect(retry.session_id).toBe(first.session_id)
    await harness.ctx.agents.get(SessionId(String(first.session_id)))!.whenIdle()
    const prompts = (await eventsOf(harness, String(first.session_id)))
      .filter(event => event.type === 'user/message' && rpcIdOf(event) === 'idempotent-start')
    expect(prompts).toHaveLength(1)
    // A reused correlation id that carries a different task never lands in the old Session.
    const other = await call(client, 'session_start', { ...args, prompt: 'a different task' })
    expect(other.session_id).not.toBe(first.session_id)
  })

  it('adopts the first attempt\'s Session when the client gave up before the receipt arrived', { timeout: 30_000 }, async () => {
    const harness = await boot({ script: [textResponse('ran once')] })
    const client = await clientFor(harness)
    const real = harness.ctx.sessionController.create.bind(harness.ctx.sessionController)
    const attempted: string[] = []
    vi.spyOn(harness.ctx.sessionController, 'create').mockImplementation(async (request) => {
      attempted.push(String(request.sessionId))
      if (attempted.length === 1) await new Promise(resolve => setTimeout(resolve, 1_000))
      return await real(request)
    })
    const args = { cwd: harness.workspace, prompt: 'do the task', request_id: 'lost-receipt' }
    // The client's own tool timeout fires long before the server-side deadline.
    await expect(client.callTool({ name: 'session_start', arguments: args }, { timeout: 200 })).rejects.toThrow()
    const retry = await call(client, 'session_start', args)
    // The abandoned first call still finishes on the server and submits its prompt.
    await vi.waitFor(async () => {
      expect(attempted).toHaveLength(2)
      const agent = harness.ctx.agents.get(SessionId(String(retry.session_id)))
      expect(agent?.status).toBe('idle')
    }, { timeout: 5_000 })
    await new Promise(resolve => setTimeout(resolve, 1_200))
    expect(new Set(attempted)).toEqual(new Set([retry.session_id]))
    const prompts = (await eventsOf(harness, String(retry.session_id)))
      .filter(event => event.type === 'user/message' && rpcIdOf(event) === 'lost-receipt')
    expect(prompts).toHaveLength(1)
  })

  it('adopts an existing session id for the same directory and refuses a conflicting one', { timeout: 30_000 }, async () => {
    const harness = await boot({ script: [textResponse('first'), textResponse('second')] })
    const client = await clientFor(harness)
    const first = await call(client, 'session_start', {
      cwd: harness.workspace,
      prompt: 'first',
      session_id: 'root-adopt',
    })
    const adopted = await call(client, 'session_start', {
      cwd: harness.workspace,
      prompt: 'second',
      session_id: 'root-adopt',
    })
    expect(adopted.session_id).toBe(first.session_id)
    await harness.ctx.agents.get(SessionId('root-adopt'))!.whenIdle()
    mkdirSync(join(harness.workspace, 'nested'))
    const conflict = await callFailure(client, 'session_start', {
      cwd: join(harness.workspace, 'nested'),
      prompt: 'third',
      session_id: 'root-adopt',
    })
    expect(conflict).toMatchObject({ code: 'session/conflict', details: { sessionId: 'root-adopt' } })
  })

  it('reports the created session and the failed stage when the prompt is refused', { timeout: 30_000 }, async () => {
    const harness = await boot({ script: [textResponse('never')] })
    const client = await clientFor(harness)
    const refusal = new Error('admission refused')
    const prompt = vi.spyOn(harness.ctx.sessionController, 'prompt').mockRejectedValue(refusal)
    const failure = await callFailure(client, 'session_start', {
      cwd: harness.workspace,
      prompt: 'will be refused',
      session_id: 'root-stage',
      request_id: 'request-stage',
    })
    prompt.mockRestore()
    expect(failure).toMatchObject({
      code: 'mcp-control/internal',
      details: { session_id: 'root-stage', request_id: 'request-stage', stage: 'prompt' },
    })
    // The session was created and deliberately kept.
    expect(harness.ctx.sessions.get(SessionId('root-stage'))).toBeDefined()
  })

  it('rejects a relative cwd, a blank prompt, an empty id, and an unknown parameter before touching DSH', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    const create = vi.spyOn(harness.ctx.sessionController, 'create')
    for (const args of [
      { cwd: 'relative/dir', prompt: 'x' },
      { cwd: harness.workspace, prompt: '   ' },
      { cwd: harness.workspace, prompt: 'x', session_id: '' },
      { cwd: harness.workspace, prompt: 'x', permission_preset: 'unknown' },
      { cwd: harness.workspace, prompt: 'x', extra: true },
      { cwd: harness.workspace },
    ]) {
      const result = await client.callTool({ name: 'session_start', arguments: args })
      expect(result.isError, JSON.stringify(args)).toBe(true)
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? ''
      expect(text, JSON.stringify(args)).toMatch(/validation error/iu)
    }
    expect(create).not.toHaveBeenCalled()
  })
})

describe('session_send', () => {
  it('lands queue delivery on the next-turn list and steer delivery on the next-step list', { timeout: 30_000 }, async () => {
    const harness = await boot({ script: ['hang', textResponse('after')] })
    const client = await clientFor(harness)
    await call(client, 'session_start', {
      cwd: harness.workspace,
      prompt: 'hold the turn',
      session_id: 'root-delivery',
    })
    const agent = harness.ctx.agents.get(SessionId('root-delivery'))
    expect(agent?.status).toBe('running')

    const queued = await call(client, 'session_send', {
      session_id: 'root-delivery',
      message: 'queued for a later turn',
      delivery: 'queue',
      request_id: 'delivery-queue',
    })
    expect(queued.accepted).toBe(true)
    const steered = await call(client, 'session_send', {
      session_id: 'root-delivery',
      message: 'steered at the next step',
      delivery: 'steer',
      request_id: 'delivery-steer',
    })
    expect(steered.accepted).toBe(true)

    expect(agent?.inbox.nextTurn.map(message => message.content[0])).toEqual([
      { type: 'text', text: 'queued for a later turn' },
    ])
    expect(agent?.inbox.nextStep.map(message => message.content[0])).toEqual([
      { type: 'text', text: 'steered at the next step' },
    ])
  })

  it('acknowledges a repeated request_id without persisting a second message', { timeout: 30_000 }, async () => {
    const harness = await boot({ script: [textResponse('settled')] })
    const client = await clientFor(harness)
    await call(client, 'session_start', {
      cwd: harness.workspace,
      prompt: 'first',
      session_id: 'root-duplicate',
    })
    await harness.ctx.agents.get(SessionId('root-duplicate'))!.whenIdle()

    const first = await call(client, 'session_send', {
      session_id: 'root-duplicate',
      message: 'same identity',
      request_id: 'repeated-request',
    })
    const second = await call(client, 'session_send', {
      session_id: 'root-duplicate',
      message: 'same identity',
      request_id: 'repeated-request',
    })
    expect(second).toEqual(first)
    const repeated = (await eventsOf(harness, 'root-duplicate'))
      .filter(event => event.type === 'user/message' && rpcIdOf(event) === 'repeated-request')
    expect(repeated).toHaveLength(1)
  })

  it('refuses an unknown session with the native code', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    const failure = await callFailure(client, 'session_send', { session_id: 'missing-root', message: 'x' })
    expect(failure.code).toBe('session/not-found')
  })

  it('mints a fresh request id when the caller omits one', { timeout: 30_000 }, async () => {
    const harness = await boot({ script: [textResponse('settled'), textResponse('settled again')] })
    const client = await clientFor(harness)
    const started = await call(client, 'session_start', {
      cwd: harness.workspace,
      prompt: 'mint',
      session_id: 'root-mint',
    })
    const sent = await call(client, 'session_send', { session_id: 'root-mint', message: 'no explicit id' })
    expect(String(started.request_id)).toMatch(/^[0-9a-f-]{36}$/u)
    expect(sent.request_id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(sent.request_id).not.toBe(started.request_id)
  })
})

describe('session_cancel', () => {
  it('interrupts the running turn and keeps unclaimed inbox entries', { timeout: 30_000 }, async () => {
    const harness = await boot({ script: ['hang', textResponse('after')] })
    const client = await clientFor(harness)
    await call(client, 'session_start', {
      cwd: harness.workspace,
      prompt: 'hold the turn',
      session_id: 'root-cancel',
    })
    await call(client, 'session_send', {
      session_id: 'root-cancel',
      message: 'still pending',
      delivery: 'queue',
      request_id: 'pending-1',
    })
    const agent = harness.ctx.agents.get(SessionId('root-cancel'))
    const receipt = await call(client, 'session_cancel', { session_id: 'root-cancel' })
    expect(receipt).toEqual({ session_id: 'root-cancel', accepted: true })
    await agent!.whenIdle()
    expect(agent?.status).toBe('idle')
    expect(agent?.inbox.nextTurn.map(message => message.content[0])).toEqual([
      { type: 'text', text: 'still pending' },
    ])
  })

  it('refuses a session whose Agent is not attached with the native code', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    const failure = await callFailure(client, 'session_cancel', { session_id: 'cold-root' })
    expect(failure).toMatchObject({ code: 'session/not-found', details: { sessionId: 'cold-root' } })
  })
})

describe('subagent control', () => {
  /** Start a live root Agent and one native continuable child below it. */
  async function withChild(harness: Harness) {
    const parent = await startRootAgent(harness, 'root-tree')
    const started = await harness.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'worker',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
      signal: new AbortController().signal,
    })
    return { parent, childId: started.childId }
  }

  it('lists the durable descendant tree with parent and depth, and relays native diagnostics', { timeout: 30_000 }, async () => {
    const harness = await boot({ script: [textResponse('child settled'), textResponse('child again')] })
    const client = await clientFor(harness)
    const { parent, childId } = await withChild(harness)
    const listed = await call(client, 'agents_list', { root_session_id: parent.id })
    expect(listed.root_session_id).toBe(parent.id)
    const entries = listed.entries as Array<Record<string, unknown>>
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'child',
      id: childId,
      mode: 'continuable',
      label: 'worker',
      parentId: parent.id,
      depth: 1,
      hasChildren: false,
    })
    expect(['running', 'inactive']).toContain(entries[0]?.activity)
  })

  it('delivers to a continuable child and reports the accepted message identity', { timeout: 30_000 }, async () => {
    const harness = await boot({ script: [textResponse('child settled'), textResponse('child again')] })
    const client = await clientFor(harness)
    const { parent, childId } = await withChild(harness)
    const delivered = await call(client, 'child_send', {
      parent_session_id: parent.id,
      child_session_id: childId,
      message: 'continue the work',
      request_id: 'child-request-1',
    })
    expect(delivered).toMatchObject({
      parent_session_id: parent.id,
      child_session_id: childId,
      request_id: 'child-request-1',
      accepted: true,
    })
    expect(String(delivered.message_id)).not.toBe('')
    const childMessages = (await eventsOf(harness, String(childId)))
      .filter(event => event.type === 'user/message' && rpcIdOf(event) === 'child-request-1')
    expect(childMessages).toHaveLength(1)
  })

  it('refuses delivery through a parent with no live Agent instead of resuming it', { timeout: 30_000 }, async () => {
    const harness = await boot({ script: [textResponse('child settled')] })
    const client = await clientFor(harness)
    const { parent, childId } = await withChild(harness)
    const failure = await callFailure(client, 'child_send', {
      parent_session_id: 'never-live-parent',
      child_session_id: childId,
      message: 'x',
    })
    expect(failure).toMatchObject({
      code: 'subagent/parent-unavailable',
      details: { parentSessionId: 'never-live-parent' },
    })
    // The real parent still addresses its own child.
    await expect(call(client, 'child_send', {
      parent_session_id: parent.id,
      child_session_id: childId,
      message: 'through the real parent',
    })).resolves.toMatchObject({ accepted: true })
  })

  it('accepts an interrupt for a child the runtime does not track, as the native no-op does', { timeout: 30_000 }, async () => {
    const harness = await boot({ script: [textResponse('child settled')] })
    const client = await clientFor(harness)
    const { parent, childId } = await withChild(harness)
    const noop = await call(client, 'child_interrupt', {
      parent_session_id: parent.id,
      child_session_id: 'unknown-child',
    })
    expect(noop).toEqual({ parent_session_id: parent.id, child_session_id: 'unknown-child', accepted: true })
    await expect(call(client, 'child_interrupt', {
      parent_session_id: parent.id,
      child_session_id: childId,
    })).resolves.toMatchObject({ accepted: true })
  })
})

describe('native failure and timeout mapping', () => {
  it('passes an agent preset through to DSH and reports its own refusal', { timeout: 30_000 }, async () => {
    const harness = await boot({ script: [textResponse('settled')] })
    const client = await clientFor(harness)
    const create = vi.spyOn(harness.ctx.sessionController, 'create')
    const failure = await callFailure(client, 'session_start', {
      cwd: harness.workspace,
      prompt: 'with a preset',
      agent_preset: 'not-a-mounted-preset',
      session_id: 'root-preset',
    })
    // The preset reached the native create call, so the refusal is DSH's own.
    expect(create.mock.calls[0]?.[0]).toMatchObject({ agentPreset: 'not-a-mounted-preset' })
    expect(failure.code).not.toBe('mcp-control/internal')
  })

  it('preserves a SubagentError raised by the durable listing', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    vi.spyOn(harness.ctx.subagents, 'listDescendants').mockRejectedValue(
      new SubagentError('the projection registry is not mounted', 'PROJECTIONS_UNAVAILABLE'),
    )
    const failure = await callFailure(client, 'agents_list', { root_session_id: 'root-1' })
    expect(failure).toMatchObject({
      code: 'PROJECTIONS_UNAVAILABLE',
      message: 'the projection registry is not mounted',
    })
  })

  it('preserves a native RemoteError raised by the parent-authorized interrupt', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    vi.spyOn(harness.ctx.subagents, 'interruptByParent').mockImplementation(() => {
      throw new RemoteError('subagent/unauthorized', 'subagent does not belong to this parent', { childSessionId: ChildId })
    })
    const failure = await callFailure(client, 'child_interrupt', {
      parent_session_id: 'parent-1',
      child_session_id: ChildId,
    })
    expect(failure).toMatchObject({
      code: 'subagent/unauthorized',
      details: { childSessionId: ChildId },
    })
  })

  it('reports a timeout with an explicitly unknown receipt instead of a false rejection', { timeout: 30_000 }, async () => {
    const harness = await boot({ config: { requestTimeoutMs: 50 } })
    const client = await clientFor(harness)
    vi.spyOn(harness.ctx.sessionController, 'prompt').mockImplementation(
      async () => await new Promise<never>(() => {}),
    )
    const failure = await callFailure(client, 'session_send', {
      session_id: 'slow-root',
      message: 'the admission never settles',
      request_id: 'timeout-request',
    })
    expect(failure).toMatchObject({
      code: 'mcp-control/request-timeout',
      details: { session_id: 'slow-root', request_id: 'timeout-request', receipt: 'unknown' },
    })
  })
})

describe('tool result and annotation contract', () => {
  it('marks only the read-only tools and never claims idempotence', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    const tools = (await client.listTools()).tools
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    for (const name of ['agents_list', 'events_read', 'session_status']) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true)
    }
    for (const name of ['session_start', 'session_send', 'session_cancel', 'child_send', 'child_interrupt']) {
      expect(byName.get(name)?.annotations?.readOnlyHint ?? false, name).toBe(false)
      expect(byName.get(name)?.annotations?.idempotentHint ?? false, name).toBe(false)
    }
  })

  it('returns the same data as structured content and as JSON text', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await clientFor(harness)
    const result = await client.callTool({
      name: 'session_cancel',
      arguments: { session_id: 'cold-root' },
    })
    expect(result.isError).toBe(true)
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? '')).toEqual(result.structuredContent)
  })

  it('degrades an oversized failure payload to result-too-large with correlation fields', { timeout: 30_000 }, async () => {
    const harness = await boot({ config: { maxToolResultBytes: 4096, defaultChunkBytes: 2048 } })
    const client = await clientFor(harness)
    const huge = 'x'.repeat(20_000)
    const reject = vi.spyOn(harness.ctx.sessionController, 'prompt').mockRejectedValue(
      Object.assign(new Error('native refusal'), {
        isDSHRemoteError: true,
        code: 'session/model-unavailable',
        details: { provider: huge, model: 'mock' },
      }),
    )
    const failure = await callFailure(client, 'session_send', { session_id: 'any-root', message: 'x' })
    reject.mockRestore()
    expect(failure.code).toBe('mcp-control/result-too-large')
    expect(failure.details).toMatchObject({ code: 'session/model-unavailable', session_id: 'any-root' })
  })
})
