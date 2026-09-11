/**
 * P1: the endpoint's request guards, credential lifecycle, route ownership,
 * unload/reload, and the real MCP handshake over the shared WebServer. Header
 * forgery and length disagreement need a raw client, because `fetch` refuses to
 * send a custom `Host` and rewrites `Content-Length`; the official MCP client
 * covers the ordinary path.
 */

import { request as httpRequest } from 'node:http'
import { createServer, ServerResponse } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Client } from '@modelcontextprotocol/client'
import { textResponse } from './support/mock-adapter.ts'
import * as McpControl from '../src/index.ts'
import { jsonBytes } from '../src/result.ts'
import {
  bootHarness,
  closeAll,
  connectClient,
  controlConfig,
  seedSession,
  startRootAgent,
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

/** One raw HTTP exchange that can set the exact headers the endpoint validates. */
interface RawAnswer {
  readonly status: number
  readonly body: string
  readonly sessionHeader: string | undefined
}

function rawHttp(
  port: number,
  options: { method: string; headers: Record<string, string | string[]>; body?: string },
): Promise<RawAnswer> {
  return new Promise<RawAnswer>((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method: options.method,
      path: '/mcp',
      headers: options.headers,
      setHost: false,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const session = response.headers['mcp-session-id']
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          sessionHeader: Array.isArray(session) ? session[0] : session,
        })
      })
    })
    request.on('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw-probe', version: '0.0.0' },
  },
})

/**
 * The `write` implementation Node installs for server responses. It lives on
 * `OutgoingMessage.prototype`, and the backpressure patch below must wrap it
 * without referencing it as a bound method.
 * @returns the implementation to wrap.
 */
function responseWrite(): (this: ServerResponse, ...args: unknown[]) => boolean {
  for (let proto: object | null = ServerResponse.prototype; proto !== null; proto = Object.getPrototypeOf(proto) as object | null) {
    const value = Object.getOwnPropertyDescriptor(proto, 'write')?.value as
      | ((this: ServerResponse, ...args: unknown[]) => boolean)
      | undefined
    if (value !== undefined) return value
  }
  throw new Error('ServerResponse has no write implementation to wrap')
}

/** Raw JSON-RPC POST headers carrying the endpoint's own authority. */
function postHeaders(harness: Harness, extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: `127.0.0.1:${String(harness.port)}`,
    authorization: `Bearer ${TEST_TOKEN}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  }
}

describe('mcp-control request guards', () => {
  it('accepts a valid bearer token and completes a real MCP handshake listing only the seven tools', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const client = await connectClient(`${harness.baseUrl}/mcp`)
    clients.push(client)
    const tools = await client.listTools()
    expect(tools.tools.map(tool => tool.name).sort()).toEqual([
      'agents_list',
      'child_interrupt',
      'child_send',
      'events_read',
      'session_cancel',
      'session_send',
      'session_start',
    ])
  })

  it('refuses a missing, malformed, wrong, empty, and duplicated bearer token with 401 before any DSH service call', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const create = vi.spyOn(harness.ctx.sessionController, 'create')
    const prompt = vi.spyOn(harness.ctx.sessionController, 'prompt')
    const base = postHeaders(harness)
    const withoutAuthorization: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(base)) {
      if (name !== 'authorization') withoutAuthorization[name] = value
    }
    const attempts: Array<[string, Record<string, string | string[]>]> = [
      ['missing', withoutAuthorization],
      ['malformed', { ...base, authorization: 'Basic abc' }],
      ['wrong', { ...base, authorization: `Bearer ${TEST_TOKEN}-wrong` }],
      ['empty', { ...base, authorization: '   ' }],
      ['duplicated', { ...base, authorization: [`Bearer ${TEST_TOKEN}`, `Bearer ${TEST_TOKEN}`] }],
    ]
    for (const [label, headers] of attempts) {
      const answer = await rawHttp(harness.port, { method: 'POST', headers, body: INITIALIZE_BODY })
      expect(answer.status, label).toBe(401)
      expect(answer.body).not.toContain(TEST_TOKEN)
    }
    expect(create).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
  })

  it('refuses a request when the credential resolves empty or its provider fails', { timeout: 30_000 }, async () => {
    const harness = await boot()
    harness.setToken('')
    const empty = await rawHttp(harness.port, {
      method: 'POST',
      headers: postHeaders(harness),
      body: INITIALIZE_BODY,
    })
    expect(empty.status).toBe(401)

    harness.setToken(TEST_TOKEN)
    vi.spyOn(harness.ctx.credentials, 'resolve').mockRejectedValue(new Error('credential store unavailable'))
    const broken = await rawHttp(harness.port, {
      method: 'POST',
      headers: postHeaders(harness),
      body: INITIALIZE_BODY,
    })
    expect(broken.status).toBe(503)
    expect(broken.body).toBe('the MCP endpoint is unavailable')
  })

  it('reports an SDK-level refusal through the endpoint logger', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const refused = await rawHttp(harness.port, {
      method: 'POST',
      headers: postHeaders(harness, { 'content-type': 'text/plain' }),
      body: INITIALIZE_BODY,
    })
    expect(refused.status).toBe(415)
    expect(warn).toHaveBeenCalledWith('mcp-control: %s', expect.stringContaining('Content-Type'))
    warn.mockRestore()
  })

  it('refuses to load on a WebServer bound beyond loopback', { timeout: 30_000 }, async () => {
    const stub = {
      webServer: { host: '0.0.0.0', port: 1 },
      credentials: { resolve: async () => ({ value: TEST_TOKEN, source: 'test' }) },
      logger: { warn: () => {} },
    } as unknown as Parameters<typeof McpControl.apply>[0]
    await expect(McpControl.apply(stub, controlConfig())).rejects.toThrow(/loopback-bound WebServer/u)
  })

  it('rotates the credential without a restart and refuses every request once it is removed', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const url = `${harness.baseUrl}/mcp`
    harness.setToken('rotated-token')
    const rotated = await connectClient(url, 'rotated-token')
    clients.push(rotated)
    expect((await rotated.listTools()).tools).toHaveLength(7)

    harness.setToken(undefined)
    const answer = await rawHttp(harness.port, {
      method: 'POST',
      headers: postHeaders(harness, { authorization: 'Bearer rotated-token' }),
      body: INITIALIZE_BODY,
    })
    expect(answer.status).toBe(401)
  })

  it('refuses a foreign Host, origin, or port and any forwarded header with 403', { timeout: 30_000 }, async () => {
    const harness = await boot()
    const attempts: Array<Record<string, string>> = [
      { host: 'evil.example:80' },
      { host: `127.0.0.1:${String(harness.port + 1)}` },
      { host: '127.0.0.1' },
      { host: 'bad host' },
      { host: '127.0.0.1:99999' },
      { host: `localhost:${String(harness.port)}` },
      { host: `127.0.0.1:${String(harness.port)}`, origin: 'http://evil.example' },
      { host: `127.0.0.1:${String(harness.port)}`, origin: 'null' },
      { host: `127.0.0.1:${String(harness.port)}`, origin: `https://127.0.0.1:${String(harness.port)}` },
      { host: `127.0.0.1:${String(harness.port)}`, origin: `http://127.0.0.1:${String(harness.port + 1)}` },
      { host: `127.0.0.1:${String(harness.port)}`, 'sec-fetch-site': 'cross-site' },
      { host: `127.0.0.1:${String(harness.port)}`, 'sec-fetch-site': 'same-site' },
      { host: `127.0.0.1:${String(harness.port)}`, 'x-forwarded-host': 'evil.example' },
      { host: `127.0.0.1:${String(harness.port)}`, forwarded: 'for=10.0.0.1' },
    ]
    for (const forged of attempts) {
      const answer = await rawHttp(harness.port, {
        method: 'POST',
        headers: { ...postHeaders(harness), ...forged },
        body: INITIALIZE_BODY,
      })
      expect(answer.status, JSON.stringify(forged)).toBe(403)
    }
  })

  it('accepts a client with no Origin and a client presenting the exact endpoint origin', { timeout: 30_000 }, async () => {
    const harness = await boot()
    for (const origin of [undefined, harness.baseUrl]) {
      const answer = await rawHttp(harness.port, {
        method: 'POST',
        headers: postHeaders(harness, {
          ...(origin === undefined ? {} : { origin }),
          ...(origin === undefined ? {} : { 'sec-fetch-site': 'same-origin' }),
        }),
        body: INITIALIZE_BODY,
      })
      expect([200, 202], origin).toContain(answer.status)
    }
  })

  it('refuses an oversized body, a mismatched Content-Length, and malformed JSON while staying alive', { timeout: 30_000 }, async () => {
    const harness = await boot({ config: { maxRequestBytes: 512 } })
    const oversized = await rawHttp(harness.port, {
      method: 'POST',
      headers: postHeaders(harness),
      body: `{"pad":"${'x'.repeat(4096)}"}`,
    })
    expect(oversized.status).toBe(413)

    const chunked = await rawHttp(harness.port, {
      method: 'POST',
      headers: postHeaders(harness, { 'transfer-encoding': 'chunked' }),
      body: `{"pad":"${'y'.repeat(4096)}"}`,
    })
    expect(chunked.status).toBe(413)

    const mismatched = await rawHttp(harness.port, {
      method: 'POST',
      headers: postHeaders(harness, { 'content-length': '4' }),
      body: INITIALIZE_BODY,
    })
    expect(mismatched.status).toBe(400)

    const malformed = await rawHttp(harness.port, {
      method: 'POST',
      headers: postHeaders(harness),
      body: '{not json',
    })
    expect(malformed.status).toBe(400)

    const client = await connectClient(`${harness.baseUrl}/mcp`)
    clients.push(client)
    expect((await client.listTools()).tools).toHaveLength(7)
  })

  it('rejects configuration the endpoint cannot serve', { timeout: 60_000 }, async () => {
    await expect(bootHarness({ config: { path: '/api' } })).rejects.toThrow(/reserved/u)
    await expect(bootHarness({ config: { path: 'mcp' } })).rejects.toThrow(/absolute/u)
    await expect(bootHarness({ config: { path: '/a/b' } })).rejects.toThrow(/single path segment/u)
    await expect(bootHarness({ config: { path: '/mcp/' } })).rejects.toThrow(/trailing slash/u)
    // The WebServer matches the normalized request pathname, so these two would
    // register and then answer 404 forever.
    await expect(bootHarness({ config: { path: '/mcp x' } })).rejects.toThrow(/\/mcp%20x/u)
    await expect(bootHarness({ config: { path: '/控制' } })).rejects.toThrow(/%E6%8E%A7%E5%88%B6/u)
    await expect(bootHarness({ config: { requestTimeoutMs: MAX_TIMER_DELAY_MS + 1 } }))
      .rejects.toThrow(new RegExp(String(MAX_TIMER_DELAY_MS), 'u'))
    await expect(bootHarness({ config: { maxEvents: 1, defaultMaxEvents: 128 } })).rejects.toThrow(/maxEvents/u)
    await expect(bootHarness({ config: { defaultChunkBytes: 1 << 21 } })).rejects.toThrow(/defaultChunkBytes/u)
    await expect(bootHarness({ config: { tokenRef: 'not a ref' } })).rejects.toThrow(/credential ref/u)
  })

  it('serves a call at the largest request timeout Node can schedule', { timeout: 30_000 }, async () => {
    const harness = await boot({
      script: [textResponse('probe')],
      config: { requestTimeoutMs: MAX_TIMER_DELAY_MS },
    })
    const client = await connectClient(`${harness.baseUrl}/mcp`)
    clients.push(client)
    const started = await client.callTool({
      name: 'session_start',
      arguments: { cwd: harness.workspace, prompt: 'largest schedulable deadline', session_id: 'timeout-max' },
    })
    expect(textJson(started).accepted).toBe(true)
  })

  it('fails to load when the credential is unresolvable', { timeout: 30_000 }, async () => {
    await expect(bootHarness({ token: undefined })).rejects.toThrow(/is not configured/u)
  })

  it('fails to load when the credential could never be presented as a Bearer token', { timeout: 30_000 }, async () => {
    // The request path accepts only the Bearer b64token alphabet, so loading
    // either credential would publish an endpoint that no conforming client can authenticate to.
    await expect(bootHarness({ token: 'not a bearer value' })).rejects.toThrow(/Bearer token/u)
    await expect(bootHarness({ token: 'emoji-🔑' })).rejects.toThrow(/Bearer token/u)
  })

  it('fails to load when its route is already owned by another registrant', { timeout: 30_000 }, async () => {
    const harness = await boot({ mountControl: false })
    harness.ctx.webServer.register({
      kind: 'exact',
      path: '/mcp',
      handler: (_request, response) => { response.writeHead(204); response.end() },
    })
    await expect(harness.ctx.plugin(McpControl, controlConfig()))
      .rejects.toThrow(/duplicate exact route/u)
  })

  it('unregisters the route on unload while the shared server keeps serving another route', { timeout: 30_000 }, async () => {
    const harness = await boot({ mountControl: false })
    const other = createServer((_request, response) => { response.writeHead(200); response.end('other') })
    await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve))
    const otherPort = (other.address() as AddressInfo).port
    try {
      const fiber = await harness.ctx.plugin(McpControl, controlConfig())
      const client = await connectClient(`${harness.baseUrl}/mcp`)
      expect((await client.listTools()).tools).toHaveLength(7)
      await fiber.dispose()
      await client.close()

      const refused = await rawHttp(harness.port, {
        method: 'POST',
        headers: postHeaders(harness),
        body: INITIALIZE_BODY,
      })
      expect(refused.sessionHeader).toBeUndefined()
      expect(refused.body).not.toContain('"jsonrpc"')
      const stillOther = await fetch(`http://127.0.0.1:${String(otherPort)}/`)
      expect(await stillOther.text()).toBe('other')
    } finally {
      await new Promise<void>(resolve => other.close(() => { resolve() }))
    }
  })

  it('terminates a request still being received when the endpoint unloads', { timeout: 30_000 }, async () => {
    const harness = await boot({ mountControl: false })
    const fiber = await harness.ctx.plugin(McpControl, controlConfig())
    // Hold admission open so the case knows the route handler owns this request
    // before the unload, instead of racing the socket.
    const admitted = Promise.withResolvers<null>()
    const release = Promise.withResolvers<null>()
    vi.spyOn(harness.ctx.credentials, 'resolve').mockImplementation(async () => {
      admitted.resolve(null)
      await release.promise
      return { value: TEST_TOKEN, source: 'test' }
    })
    const partial = httpRequest({
      host: '127.0.0.1',
      port: harness.port,
      method: 'POST',
      path: '/mcp',
      headers: { ...postHeaders(harness), 'content-length': '4096' },
      setHost: false,
    })
    let answered = false
    let closed = false
    partial.once('response', () => { answered = true })
    partial.once('error', () => { closed = true })
    partial.once('close', () => { closed = true })
    try {
      // Headers and a partial body: the client never finishes sending, and the
      // per-call timeout does not cover a body still being received.
      partial.write('{"jsonrpc":"2.0",')
      await admitted.promise
      release.resolve(null)
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      await fiber.dispose()
      await vi.waitFor(() => { expect(closed).toBe(true) }, { timeout: 5_000, interval: 50 })
      expect(answered).toBe(false)
    } finally {
      partial.destroy()
    }
  })

  it('completes unload while a client has stopped reading a large response', { timeout: 60_000 }, async () => {
    // A response far larger than the socket buffers comes from a real durable
    // log, so the SDK's response write genuinely blocks on backpressure.
    const harness = await boot({
      mountControl: false,
      script: ['hang', textResponse('finished after unload')],
      config: { maxToolResultBytes: 64 * 1024 * 1024, requestTimeoutMs: 60_000 },
    })
    await seedSession(harness, 'backpressure', (session) => {
      for (let index = 0; index < 40; index += 1) {
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: `${String(index)}:${'x'.repeat(65_536)}` }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
      }
    })
    // A second route on the same shared listener, to prove the unload ends the
    // endpoint's own requests without touching the server they arrived on.
    const disposeUnrelated = harness.ctx.webServer.register({
      kind: 'exact',
      path: '/unrelated',
      handler: (_request, response) => { response.writeHead(200); response.end('unrelated') },
    })
    const fiber = await harness.ctx.plugin(McpControl, controlConfig({
      maxToolResultBytes: 64 * 1024 * 1024,
      requestTimeoutMs: 60_000,
    }))
    const agent = await startRootAgent(harness, 'backpressure-live')
    const driver = await connectClient(`${harness.baseUrl}/mcp`)
    clients.push(driver)
    const holding = await driver.callTool({
      name: 'session_send',
      arguments: { session_id: 'backpressure-live', message: 'hold this turn', request_id: 'backpressure-1' },
    })
    expect(textJson(holding).accepted).toBe(true)
    await vi.waitFor(() => { expect(agent.status).toBe('running') }, { timeout: 5_000, interval: 20 })

    // Barrier: the server's own write returned false, so the SDK adapter is
    // waiting for a drain the paused client will never produce.
    const backpressured = Promise.withResolvers<null>()
    const originalWrite = responseWrite()
    // `write` is overloaded in Node's declarations, so the patch is typed by
    // the implementation it wraps rather than by the public overload set.
    ServerResponse.prototype.write = function patchedWrite(
      this: ServerResponse,
      chunk: unknown,
      ...rest: unknown[]
    ): boolean {
      const accepted = originalWrite.call(this, chunk, ...rest)
      if (!accepted) backpressured.resolve(null)
      return accepted
    } as typeof ServerResponse.prototype.write
    const request = httpRequest({
      host: '127.0.0.1',
      port: harness.port,
      method: 'POST',
      path: '/mcp',
      headers: { ...postHeaders(harness), 'mcp-protocol-version': '2025-03-26' },
      setHost: false,
    })
    let headersArrived = false
    let responseEnded = false
    let connectionEndedEarly = false
    let response: IncomingMessage | undefined
    request.on('response', (answer) => {
      headersArrived = true
      response = answer
      // The client stops reading here; from this point the endpoint cannot
      // finish its write without ending the request itself.
      answer.pause()
      answer.on('end', () => { responseEnded = true })
      answer.on('aborted', () => { connectionEndedEarly = true })
    })
    request.on('error', () => { connectionEndedEarly = true })
    request.end(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'events_read', arguments: { address: { kind: 'session', session_id: 'backpressure' }, max_events: 512 } },
    }))
    try {
      await backpressured.promise
      // The header bytes are small and already queued; the body is what cannot
      // be delivered. Waiting for them proves the client stopped reading with
      // the response genuinely in flight.
      await vi.waitFor(() => { expect(headersArrived).toBe(true) }, { timeout: 5_000, interval: 20 })

      await fiber.dispose()

      // The endpoint ended its own request instead of waiting for a reader that
      // stopped. The paused client cannot have observed that yet, so it reads
      // once more and must find a terminated response rather than the payload.
      expect(responseEnded).toBe(false)
      response?.resume()
      await vi.waitFor(() => { expect(connectionEndedEarly).toBe(true) }, { timeout: 5_000, interval: 20 })
      expect(responseEnded).toBe(false)

      // The shared listener still serves its other route.
      const stillUnrelated = await fetch(`${harness.baseUrl}/unrelated`)
      expect(await stillUnrelated.text()).toBe('unrelated')

      // The Agent running throughout was never the endpoint's to stop, and a
      // reloaded endpoint still controls it.
      expect(harness.ctx.agents.get(SessionId('backpressure-live'))?.status).toBe('running')
      const secondMount = await harness.ctx.plugin(McpControl, controlConfig())
      const second = await connectClient(`${harness.baseUrl}/mcp`)
      clients.push(second)
      const cancelled = await second.callTool({ name: 'session_cancel', arguments: { session_id: 'backpressure-live' } })
      expect(textJson(cancelled).accepted).toBe(true)
      await agent.whenIdle()
      expect(agent.status).toBe('idle')
      await secondMount.dispose()
    } finally {
      ServerResponse.prototype.write = originalWrite
      request.destroy()
      disposeUnrelated()
    }
  })

  it('reloads the endpoint while a root Agent is running without stopping it', { timeout: 30_000 }, async () => {
    const harness = await boot({ mountControl: false, script: ['hang', textResponse('finished after reload')] })
    const url = `${harness.baseUrl}/mcp`
    const firstMount = await harness.ctx.plugin(McpControl, controlConfig())
    const first = await connectClient(url)
    const started = await first.callTool({
      name: 'session_start',
      arguments: { cwd: harness.workspace, prompt: 'hold the turn', session_id: 'reload-live', request_id: 'reload-live-1' },
    })
    expect(textJson(started).accepted).toBe(true)
    const cursorPage = await first.callTool({
      name: 'events_read',
      arguments: { address: { kind: 'session', session_id: 'reload-live' }, after_seq: -1 },
    })
    const cursor = textJson(cursorPage).next_seq as number
    const agent = harness.ctx.agents.get(SessionId('reload-live'))
    expect(agent?.status).toBe('running')
    await first.close()
    await firstMount.dispose()
    // The plugin unload removes the endpoint; the Agent the endpoint started is
    // not the plugin's to stop.
    expect(harness.ctx.agents.get(SessionId('reload-live'))?.status).toBe('running')

    const secondMount = await harness.ctx.plugin(McpControl, controlConfig())
    const second = await connectClient(url)
    clients.push(second)
    // The reloaded endpoint reads the same durable log forward from the cursor
    // the first mount handed out.
    const resumed = await second.callTool({
      name: 'events_read',
      arguments: { address: { kind: 'session', session_id: 'reload-live' }, after_seq: cursor },
    })
    expect(textJson(resumed).mode).toBe('page')
    const cancelled = await second.callTool({ name: 'session_cancel', arguments: { session_id: 'reload-live' } })
    expect(textJson(cancelled).accepted).toBe(true)
    await agent!.whenIdle()
    expect(agent?.status).toBe('idle')
    await secondMount.dispose()
  })

  it('reloads the endpoint and keeps a started session readable by id', { timeout: 30_000 }, async () => {    const harness = await boot({ mountControl: false })
    const url = `${harness.baseUrl}/mcp`
    const firstMount = await harness.ctx.plugin(McpControl, controlConfig())
    const first = await connectClient(url)
    const started = await first.callTool({
      name: 'session_start',
      arguments: { cwd: harness.workspace, prompt: 'hold', request_id: 'reload-1' },
    })
    const sessionId = textJson(started).session_id as string
    await first.close()
    await firstMount.dispose()

    const secondMount = await harness.ctx.plugin(McpControl, controlConfig())
    const second = await connectClient(url)
    clients.push(second)
    const page = await second.callTool({
      name: 'events_read',
      arguments: { address: { kind: 'session', session_id: sessionId }, after_seq: -1 },
    })
    expect(textJson(page).mode).toBe('page')
    expect(textJson(page).head_seq).toBeGreaterThanOrEqual(0)
    await secondMount.dispose()
  })
})

/**
 * P1 result budget: the configured ceiling covers the complete CallToolResult
 * on every path, including the one the SDK builds by itself when arguments fail
 * validation. Each case drives the real HTTP endpoint and measures the result
 * the official client received, so the declared budget is checked where the
 * caller sees it.
 */
describe('mcp-control result budget over HTTP', () => {
  /** The smallest budget `Config` admits, where every path is tightest. */
  const MINIMUM_BUDGET = 4096

  /** The failure the endpoint reported, as the caller receives it. */
  function errorOf(result: { structuredContent?: unknown }): {
    code: string
    message: string
    details: Record<string, unknown>
  } {
    const structured = result.structuredContent as { error?: unknown } | undefined
    const error = structured?.error as { code?: unknown; message?: unknown; details?: unknown } | undefined
    if (error === undefined || typeof error.code !== 'string' || typeof error.message !== 'string') {
      throw new Error(`result carried no structured error: ${JSON.stringify(result.structuredContent)}`)
    }
    return {
      code: error.code,
      message: error.message,
      details: (error.details ?? {}) as Record<string, unknown>,
    }
  }

  /** The text part of one result, or an empty string when it carries none. */
  function textOf(result: { content?: unknown }): string {
    const content = result.content
    if (!Array.isArray(content)) return ''
    return content
      .filter((part): part is { type: string; text: string } => {
        const candidate = part as { type?: unknown; text?: unknown }
        return candidate.type === 'text' && typeof candidate.text === 'string'
      })
      .map(part => part.text)
      .join('')
  }

  it('answers an empty page inside the smallest budget', { timeout: 30_000 }, async () => {
    const harness = await boot({ config: { maxToolResultBytes: MINIMUM_BUDGET, defaultChunkBytes: 2048 } })
    await seedSession(harness, 'budget-empty', (session) => {
      session.append('turn/start', { turn: 1 })
    })
    const client = await connectClient(`${harness.baseUrl}/mcp`)
    clients.push(client)
    const page = await client.callTool({
      name: 'events_read',
      arguments: { address: { kind: 'session', session_id: 'budget-empty' }, after_seq: 0 },
    })
    expect(page.isError).toBeUndefined()
    expect(textJson(page).mode).toBe('page')
    expect(jsonBytes(page)).toBeLessThanOrEqual(MINIMUM_BUDGET)
  })

  it('bounds a multibyte failure, keeps the correlation fields that fit, and names the rest', { timeout: 30_000 }, async () => {
    const harness = await boot({ config: { maxToolResultBytes: MINIMUM_BUDGET, defaultChunkBytes: 2048 } })
    const client = await connectClient(`${harness.baseUrl}/mcp`)
    clients.push(client)
    // Three 256-character ids of three-byte code points: the payload that
    // pushed the unbounded fallback to 5167 bytes.
    const id = '界'.repeat(256)
    const result = await client.callTool({
      name: 'child_send',
      arguments: {
        parent_session_id: id,
        child_session_id: id,
        message: 'deliver nothing',
        request_id: id,
      },
    })
    expect(result.isError).toBe(true)
    expect(jsonBytes(result)).toBeLessThanOrEqual(MINIMUM_BUDGET)
    const error = errorOf(result)
    expect(error.code).toBe('mcp-control/result-too-large')
    // The original code and the correlation fields the budget admits survive
    // verbatim; the dropped ones are named rather than silently removed.
    expect(error.details.code).toBe('subagent/parent-unavailable')
    const kept = Object.entries(error.details).filter(([key, value]) => key.endsWith('_id') && value === id)
    expect(kept.length).toBeGreaterThan(0)
    const omitted = error.details.omitted as string[]
    expect(omitted).toContain('parent_session_id')
    expect(omitted.length + kept.length).toBe(3)
  })

  it('bounds a failure whose correlation values need JSON escaping', { timeout: 30_000 }, async () => {
    const harness = await boot({ config: { maxToolResultBytes: MINIMUM_BUDGET, defaultChunkBytes: 2048 } })
    const client = await connectClient(`${harness.baseUrl}/mcp`)
    clients.push(client)
    // Quotes, backslashes, control characters, and an astral plane code point:
    // every value doubles when JSON-escaped, so the measured budget has to
    // count escaped bytes rather than characters.
    const id = '"\\\n\t🙂'.repeat(40)
    const result = await client.callTool({
      name: 'child_send',
      arguments: {
        parent_session_id: id,
        child_session_id: id,
        message: 'deliver nothing',
        request_id: id,
      },
    })
    expect(result.isError).toBe(true)
    expect(jsonBytes(result)).toBeLessThanOrEqual(MINIMUM_BUDGET)
    const error = errorOf(result)
    expect(error.code).toBe('mcp-control/result-too-large')
    const survivors = Object.values(error.details).filter(value => value === id)
    // Whatever survived is the caller's own value, not a cut in the middle of
    // an escape sequence.
    for (const value of survivors) expect(value).toBe(id)
    expect(survivors.length).toBeGreaterThan(0)
  })

  it('bounds the validation failure the SDK builds for an oversized unknown argument', { timeout: 30_000 }, async () => {
    const harness = await boot({ config: { maxToolResultBytes: MINIMUM_BUDGET, defaultChunkBytes: 2048 } })
    const client = await connectClient(`${harness.baseUrl}/mcp`)
    clients.push(client)
    const cancel = vi.spyOn(harness.ctx.sessionController, 'cancel')
    // An unrecognized key whose name alone is longer than the whole budget; the
    // SDK echoes it in the error it builds before any handler runs.
    const result = await client.callTool({
      name: 'session_cancel',
      arguments: { session_id: 'fixture', ['x'.repeat(9000)]: true },
    })
    expect(result.isError).toBe(true)
    expect(jsonBytes(result)).toBeLessThanOrEqual(MINIMUM_BUDGET)
    const text = textOf(result)
    expect(text).toContain('Input validation error')
    expect(text).toContain('Unrecognized key')
    // The shortened diagnostic names what it replaced instead of pretending
    // the argument was accepted or that the key was short.
    expect(text).toContain('truncated')
    expect(text).toMatch(/the complete diagnostic is \d+ bytes/u)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('never cuts a surrogate pair when it shortens a validation diagnostic', { timeout: 30_000 }, async () => {
    const harness = await boot({ config: { maxToolResultBytes: MINIMUM_BUDGET, defaultChunkBytes: 2048 } })
    const client = await connectClient(`${harness.baseUrl}/mcp`)
    clients.push(client)
    const result = await client.callTool({
      name: 'session_cancel',
      arguments: { session_id: 'fixture', ['🙂'.repeat(2000)]: true },
    })
    expect(result.isError).toBe(true)
    expect(jsonBytes(result)).toBeLessThanOrEqual(MINIMUM_BUDGET)
    const text = textOf(result)
    expect(text).toContain('truncated')
    // A lone surrogate would survive JSON transport as an escape sequence but
    // is not a code point the caller can match against its own argument.
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
    expect(text).not.toContain('\uFFFD')
  })
})
