/** Regression acceptance for the four runtime review findings; no paid model calls. */
import { spawnSync } from 'node:child_process'
import { request } from 'node:http'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Client } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as McpControl from '../src/index.ts'
import { bootHarness, closeAll, connectClient, controlConfig, startRootAgent, textJson, TEST_TOKEN, type Harness } from './harness.ts'
import { textResponse } from './support/mock-adapter.ts'

const harnesses: Harness[] = []
const clients: Client[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await closeAll(clients.splice(0), harnesses.splice(0))
})

async function boot(options: Parameters<typeof bootHarness>[0] = {}) {
  const h = await bootHarness(options)
  harnesses.push(h)
  vi.spyOn(h.adapter, 'stream').mockImplementation(async function* () { yield* textResponse('settled') })
  return h
}

async function clientFor(h: Harness) {
  const c = await connectClient(`${h.baseUrl}/mcp`)
  clients.push(c)
  return c
}

async function withChild(h: Harness) {
  const parent = await startRootAgent(h, 'review-parent')
  const child = await h.ctx.subagents.startActivation({ delivery: 'caller', provider: 'spawn', label: 'worker',
    request: { parent, prompt: [{ type: 'text', text: 'initial task' }] }, signal: new AbortController().signal })
  await h.ctx.agents.get(child.childId)?.whenIdle()
  return { parent_session_id: String(parent.id), child_session_id: String(child.childId),
    message: 'one requested change', request_id: 'review-delivery' }
}

async function sent(c: Client, args: Record<string, unknown>) {
  const result = await c.callTool({ name: 'child_send', arguments: args })
  expect(result.isError).not.toBe(true)
  return textJson(result)
}

async function expectOne(h: Harness, args: { child_session_id: string; request_id: string }) {
  await vi.waitFor(async () => {
    const events = (await h.ctx.sessionController.inspect(SessionId(args.child_session_id))).events
    expect(events.filter(e => e.type === 'user/message'
      && (e.data as { source?: { rpcId?: string } }).source?.rpcId === args.request_id)).toHaveLength(1)
  })
}

describe('configured request size reaches both SDK adapters', () => {
  it('accepts a valid request above 4MiB, and still rejects bytes above the configured cap', async () => {
    const h = await boot({ config: { maxRequestBytes: 5 * 1024 * 1024 } })
    async function initialize(size: number, sendBody = true) {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x'.repeat(size), version: '1' },
      } })
      return await new Promise<{ status: number; text: string }>((resolve, reject) => {
        let answer: { status: number; text: string } | undefined
        let uploaded = false
        const complete = () => { if (uploaded && answer !== undefined) resolve(answer) }
        // Own this exchange's socket and await both upload and response.
        const req = request({ host: '127.0.0.1', port: h.port, path: '/mcp', method: 'POST', agent: false, headers: {
          authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json',
          accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body),
        } }, res => {
          const parts: Buffer[] = []
          res.on('data', (chunk: Buffer) => parts.push(chunk))
          res.on('error', reject)
          res.on('end', () => {
            answer = { status: res.statusCode ?? 0, text: Buffer.concat(parts).toString() }
            complete()
          })
        })
        req.on('finish', () => { uploaded = true; complete() })
        req.on('error', reject)
        req.end(sendBody ? body : undefined)
      })
    }
    const accepted = await initialize(4_500_000)
    expect(accepted.status).toBe(200)
    const payload = accepted.text.startsWith('event:')
      ? accepted.text.split('\n').find(line => line.startsWith('data: '))?.slice(6) : accepted.text
    expect(JSON.parse(payload ?? '')).toMatchObject({ result: { serverInfo: { name: 'deepseek-harness-mcp-control' } } })
    // The declared size is refused before intake. Don't race an intentionally
    // rejected multi-megabyte upload against the server's early close; the
    // guard tests separately cover received bytes exceeding the ceiling.
    expect((await initialize(5_500_000, false)).status).toBe(413)
  })
})

describe('session_start admission serialization', () => {
  it('holds the admission slot after a deadline and endpoint reload', { timeout: 20000 }, async () => {
    const h = await boot({ mountControl: false })
    const config = controlConfig({ requestTimeoutMs: 350 })
    const mounted = await h.ctx.plugin(McpControl, config).await()
    const first = await clientFor(h)
    const args = { cwd: h.workspace, prompt: 'one task', request_id: 'root-delivery', session_id: 'root-admission' }
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = h.ctx.sessionController.prompt.bind(h.ctx.sessionController)
    const native = vi.spyOn(h.ctx.sessionController, 'prompt').mockImplementation(async request => {
      await gate
      return await original(request, new AbortController().signal)
    })
    try {
      expect(textJson(await first.callTool({ name: 'session_start', arguments: args })))
        .toMatchObject({ error: { code: 'mcp-control/request-timeout', details: { stage: 'prompt' } } })
      await first.close()
      await mounted.dispose()
      await h.ctx.plugin(McpControl, config).await()
      const retry = await clientFor(h)
      expect(textJson(await retry.callTool({ name: 'session_start', arguments: args })))
        .toMatchObject({ error: { code: 'mcp-control/request-timeout' } })
      expect(native).toHaveBeenCalledTimes(1)
      release()
      await h.ctx.agents.get(SessionId(args.session_id))?.whenIdle()
      const recovered = await retry.callTool({ name: 'session_start', arguments: args })
      expect(recovered.isError).not.toBe(true)
      expect(native).toHaveBeenCalledTimes(1)
      await vi.waitFor(async () => {
        const events = (await h.ctx.sessionController.inspect(SessionId(args.session_id))).events
        expect(events.filter(e => e.type === 'user/message'
          && (e.data as { source?: { rpcId?: string } }).source?.rpcId === args.request_id)).toHaveLength(1)
      })
    } finally { release() }
  })
})

describe('child_send durable idempotency', () => {
  it('returns the same message across connections; a fresh request id admits new work', async () => {
    const h = await boot()
    const args = await withChild(h)
    const first = await clientFor(h)
    const second = await clientFor(h)
    const native = vi.spyOn(h.ctx.subagents, 'prompt')
    const receipts = await Promise.all([sent(first, args), sent(second, args)])
    expect(receipts[0]?.message_id).toBe(receipts[1]?.message_id)
    expect((await sent(second, args)).message_id).toBe(receipts[0]?.message_id)
    expect(native).toHaveBeenCalledTimes(1)
    await expectOne(h, args)
    expect((await sent(second, { ...args, request_id: 'new-delivery' })).message_id).not.toBe(receipts[0]?.message_id)
    expect(native).toHaveBeenCalledTimes(2)
  })

  it('keeps unresolved admission serialized through deadlines and endpoint reload', { timeout: 20000 }, async () => {
    const h = await boot({ mountControl: false })
    const config = controlConfig({ requestTimeoutMs: 350 })
    const mounted = await h.ctx.plugin(McpControl, config).await()
    const args = await withChild(h)
    const first = await clientFor(h)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = h.ctx.subagents.prompt.bind(h.ctx.subagents)
    const native = vi.spyOn(h.ctx.subagents, 'prompt').mockImplementation(async request => {
      await gate
      // Model already-entered native work that outlives the HTTP cancellation.
      return await original(request, new AbortController().signal)
    })
    try {
      const abandoned = await first.callTool({ name: 'child_send', arguments: args })
      expect(textJson(abandoned)).toMatchObject({ error: { code: 'mcp-control/request-timeout' } })
      await first.close()
      await mounted.dispose()
      await h.ctx.plugin(McpControl, config).await()
      const retry = await clientFor(h)
      const waiting = await retry.callTool({ name: 'child_send', arguments: args })
      expect(textJson(waiting)).toMatchObject({ error: { code: 'mcp-control/request-timeout' } })
      expect(native).toHaveBeenCalledTimes(1)
      release()
      await expectOne(h, args)
      expect((await sent(retry, args)).accepted).toBe(true)
      expect(native).toHaveBeenCalledTimes(1)
    } finally { release() }
  })

  it('permits retry after refusal, and never returns a receipt through a different parent', async () => {
    const h = await boot()
    const args = await withChild(h)
    const c = await clientFor(h)
    const native = vi.spyOn(h.ctx.subagents, 'prompt')
      .mockRejectedValueOnce(new RemoteError('subagent/delivery-unavailable', 'not accepted', { childSessionId: SessionId(args.child_session_id) }))
    const refused = await c.callTool({ name: 'child_send', arguments: args })
    expect(textJson(refused)).toMatchObject({ error: { code: 'subagent/delivery-unavailable' } })
    await sent(c, args)
    const stranger = await startRootAgent(h, 'other-parent')
    const unauthorized = await c.callTool({ name: 'child_send', arguments: { ...args, parent_session_id: stranger.id } })
    expect(textJson(unauthorized)).toMatchObject({ error: { code: 'subagent/unauthorized' } })
    expect(native).toHaveBeenCalledTimes(2)
    await expectOne(h, args)
  })

  it('recovers the original receipt from persisted history without resuming a cold child', { timeout: 30000 }, async () => {
    const first = await boot({ retainRoots: true })
    const args = await withChild(first)
    const c = await clientFor(first)
    const receipt = await sent(c, args)
    await expectOne(first, args)
    await first.ctx.agents.get(SessionId(args.child_session_id))?.whenIdle()
    await first.ctx.agents.get(SessionId(args.parent_session_id))?.whenIdle()
    await c.close()
    await first.dispose()
    harnesses.splice(harnesses.indexOf(first), 1)
    const second = await boot({ workspace: first.workspace, persistenceRoot: first.persistenceRoot })
    const retry = await clientFor(second)
    const cold = await retry.callTool({ name: 'child_send', arguments: args })
    expect(textJson(cold)).toMatchObject({ error: { code: 'subagent/parent-unavailable' } })
    const resumed = await retry.callTool({ name: 'session_send', arguments: {
      session_id: args.parent_session_id, message: 'resume parent', request_id: 'resume-parent',
    } })
    expect(resumed.isError).not.toBe(true)
    expect(second.ctx.agents.get(SessionId(args.child_session_id))).toBeUndefined()
    const native = vi.spyOn(second.ctx.subagents, 'prompt')
    expect((await sent(retry, args)).message_id).toBe(receipt.message_id)
    expect(native).not.toHaveBeenCalled()
    expect(second.ctx.agents.get(SessionId(args.child_session_id))).toBeUndefined()
  })
})

describe('native query errors and pre-aborted deadlines', () => {
  it('maps an unknown root to session/not-found and preserves other typed query failures', async () => {
    const h = await boot()
    const c = await clientFor(h)
    const missing = await c.callTool({ name: 'agents_list', arguments: { root_session_id: 'missing-root' } })
    expect(textJson(missing)).toMatchObject({ error: { code: 'session/not-found', details: { sessionId: 'missing-root' } } })
    vi.spyOn(h.ctx.subagents, 'listDescendants').mockRejectedValueOnce(
      new SessionQueryError('stored root is corrupt', 'SESSION_QUERY_CORRUPT_SESSION'))
    const corrupt = await c.callTool({ name: 'agents_list', arguments: { root_session_id: 'corrupt-root' } })
    expect(textJson(corrupt)).toMatchObject({ error: { code: 'SESSION_QUERY_CORRUPT_SESSION', message: 'stored root is corrupt' } })
  })

  it('consumes immediate and delayed native rejections when the signal was already aborted', () => {
    const script = `import { withinDeadline } from './src/result.ts';
const c = new AbortController(); c.abort(new Error('already cancelled'));
for (const work of [Promise.reject(new Error('immediate native failure')),
  new Promise((_, reject) => setTimeout(() => reject(new Error('late native failure')), 15))]) {
  await withinDeadline(work, c.signal).catch(error => { if (error !== c.signal.reason) throw error; });
}
await new Promise(resolve => setTimeout(resolve, 40)); console.log('no-unhandled-rejection');`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 })
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toContain('no-unhandled-rejection')
  })
})
