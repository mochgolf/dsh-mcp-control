/**
 * P1: the request guards and the result/failure mapping at their exact
 * boundaries. These are the arms a real socket cannot reach — a duplicated
 * `Host`, a declared length that disagrees with the received bytes, an empty
 * presented token — so each is driven directly with a minimal request double
 * while the same guards are also exercised end to end in `http.spec.ts`.
 */

import type { IncomingMessage } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ServerContext } from '@modelcontextprotocol/server'
import type { ResolvedConfig } from '../src/config.ts'
import {
  assertLoopbackAuthority,
  assertSameOrigin,
  canPresentAsBearer,
  ControlHttpError,
  endpointOrigin,
  presentedBearerToken,
  readBoundedBody,
  replayableRequest,
  tokenMatches,
} from '../src/http.ts'
import { chunkBytes } from '../src/events.ts'
import {
  boundedInputSchema,
  boundedIssues,
  errorResult,
  failureResult,
  jsonBytes,
  okResult,
  okWithinBudget,
  operationDeadline,
  withinDeadline,
  type ControlDeps,
} from '../src/result.ts'

/** One request double carrying exactly the header tables the guards read. */
function request(headers: Record<string, string | string[]>): IncomingMessage {
  const headersDistinct: Record<string, string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    headersDistinct[name] = Array.isArray(value) ? value : [value]
  }
  return { headers, headersDistinct } as unknown as IncomingMessage
}

/** A request double whose body stream is scripted. */
function bodyRequest(
  headers: Record<string, string>,
  chunks: Array<Buffer | string | Error>,
  complete = true,
): IncomingMessage & { resumed: number } {
  const state = { resumed: 0 }
  return {
    headers,
    headersDistinct: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, [value]])),
    complete,
    resume() { state.resumed += 1 },
    get resumed() { return state.resumed },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        if (chunk instanceof Error) throw chunk
        yield chunk
      }
    },
  } as unknown as IncomingMessage & { resumed: number }
}

/** Assert one guard refusal with its exact status. */
function refusal(run: () => unknown, status: number, message: RegExp): void {
  try {
    run()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ControlHttpError)
    expect((error as ControlHttpError).status).toBe(status)
    expect((error as ControlHttpError).message).toMatch(message)
    return
  }
  throw new Error('the guard accepted a request it must refuse')
}

describe('loopback authority', () => {
  it('accepts only the exact bound authority, including the default port', () => {
    expect(assertLoopbackAuthority(request({ host: '127.0.0.1:3080' }), 3080)).toBe(endpointOrigin(3080))
    expect(assertLoopbackAuthority(request({ host: '127.0.0.1' }), 80)).toBe(endpointOrigin(80))
    expect(assertLoopbackAuthority(request({ host: '127.0.0.1:80' }), 80)).toBe(endpointOrigin(80))
  })

  it('refuses a missing, ambiguous, or empty Host header', () => {
    refusal(() => assertLoopbackAuthority(request({}), 3080), 403, /missing Host/u)
    refusal(() => assertLoopbackAuthority(request({ host: ['127.0.0.1:3080', '127.0.0.1:3080'] }), 3080), 403, /ambiguous/u)
    refusal(() => assertLoopbackAuthority(request({ host: '   ' }), 3080), 403, /empty/u)
  })

  it('refuses a malformed, foreign, or wrong-port authority', () => {
    refusal(() => assertLoopbackAuthority(request({ host: 'bad host' }), 3080), 403, /malformed/u)
    refusal(() => assertLoopbackAuthority(request({ host: '127.0.0.1:99999' }), 3080), 403, /malformed/u)
    refusal(() => assertLoopbackAuthority(request({ host: '127.0.0.1:3080' }), 80), 403, /does not match/u)
    refusal(() => assertLoopbackAuthority(request({ host: 'localhost:3080' }), 3080), 403, /loopback/u)
    refusal(() => assertLoopbackAuthority(request({ host: '0.0.0.0:3080' }), 3080), 403, /loopback/u)
  })
})

describe('origin and proxy refusal', () => {
  it('refuses every forwarding header and a foreign or null Origin', () => {
    const origin = endpointOrigin(3080)
    for (const name of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip']) {
      refusal(() => { assertSameOrigin(request({ [name]: 'value' }), origin) }, 403, /not accepted/u)
    }
    refusal(() => { assertSameOrigin(request({ origin: 'null' }), origin) }, 403, /Origin must equal/u)
    refusal(() => { assertSameOrigin(request({ origin: 'https://127.0.0.1:3080' }), origin) }, 403, /Origin must equal/u)
    refusal(() => { assertSameOrigin(request({ origin: ['http://127.0.0.1:3080', 'http://127.0.0.1:3080'] }), origin) }, 403, /ambiguous/u)
  })

  it('refuses any cross-site fetch metadata and accepts the same-origin forms', () => {
    const origin = endpointOrigin(3080)
    refusal(() => { assertSameOrigin(request({ 'sec-fetch-site': 'cross-site' }), origin) }, 403, /cross-site/u)
    refusal(() => { assertSameOrigin(request({ 'sec-fetch-site': 'same-site' }), origin) }, 403, /cross-site/u)
    expect(() => { assertSameOrigin(request({ 'sec-fetch-site': 'same-origin', origin }), origin) }).not.toThrow()
    expect(() => { assertSameOrigin(request({ 'sec-fetch-site': 'none', origin }), origin) }).not.toThrow()
    expect(() => { assertSameOrigin(request({}), origin) }).not.toThrow()
  })
})

describe('bearer token intake', () => {
  it('accepts only a single well-formed Bearer value', () => {
    expect(presentedBearerToken(request({ authorization: 'Bearer abc.def' }))).toBe('abc.def')
  })

  it('refuses a missing, empty, malformed, or differently spelled authorization header', () => {
    refusal(() => presentedBearerToken(request({})), 401, /missing Authorization/u)
    refusal(() => presentedBearerToken(request({ authorization: '   ' })), 401, /empty authorization/u)
    refusal(() => presentedBearerToken(request({ authorization: 'Basic abc' })), 401, /must be a Bearer token/u)
    refusal(() => presentedBearerToken(request({ authorization: 'bearer abc' })), 401, /must be a Bearer token/u)
    refusal(() => presentedBearerToken(request({ authorization: 'Bearer  abc' })), 401, /must be a Bearer token/u)
    refusal(() => presentedBearerToken(request({ authorization: 'Bearer ' })), 401, /must be a Bearer token/u)
  })

  it('compares tokens in constant time and never on an empty value', () => {
    expect(tokenMatches('token-value', 'token-value')).toBe(true)
    expect(tokenMatches('token-value', 'token-valuf')).toBe(false)
    expect(tokenMatches('short', 'a-much-longer-token')).toBe(false)
    expect(tokenMatches('', 'token-value')).toBe(false)
    expect(tokenMatches('', '')).toBe(false)
  })

  it('accepts only the RFC 6750 Bearer b64token grammar', () => {
    for (const value of ['fixture-token-value', 'a.b-c_d~e', 'abc+/==', 'x'.repeat(120)]) {
      expect(canPresentAsBearer(value), JSON.stringify(value)).toBe(true)
      expect(presentedBearerToken(request({ authorization: `Bearer ${value}` }))).toBe(value)
    }
    for (const value of ['has space', 'tab\there', ' leading', 'trailing ', '', 'emoji-🔑', 'colon:value', '=']) {
      expect(canPresentAsBearer(value), JSON.stringify(value)).toBe(false)
    }
  })
})

describe('bounded body intake', () => {
  it('reads the received bytes and rejects a declared length above the ceiling without reading', async () => {
    await expect(readBoundedBody(bodyRequest({}, ['abc']), 8)).resolves.toEqual(Buffer.from('abc'))
    const declared = bodyRequest({ 'content-length': '64' }, ['abc'])
    await expect(readBoundedBody(declared, 8)).rejects.toMatchObject({ status: 413 })
    expect(declared.resumed).toBe(1)
  })

  it('rejects an invalid or non-representable Content-Length', async () => {
    await expect(readBoundedBody(bodyRequest({ 'content-length': 'abc' }, ['x']), 8))
      .rejects.toMatchObject({ status: 400 })
    await expect(readBoundedBody(bodyRequest({ 'content-length': '9'.repeat(20) }, ['x']), Number.MAX_SAFE_INTEGER))
      .rejects.toMatchObject({ status: 413 })
  })

  it('stops at the ceiling even when the declared length is honest', async () => {
    const overflowing = bodyRequest({}, ['12345', '67890'])
    await expect(readBoundedBody(overflowing, 4)).rejects.toMatchObject({ status: 413 })
    expect(overflowing.resumed).toBe(1)
  })

  it('rejects an aborted, incomplete, or length-disagreeing body', async () => {
    await expect(readBoundedBody(bodyRequest({}, [new Error('socket closed')]), 8))
      .rejects.toMatchObject({ status: 400, message: 'request body was aborted' })
    await expect(readBoundedBody(bodyRequest({}, ['abc'], false), 8))
      .rejects.toMatchObject({ status: 400, message: 'request body was aborted' })
    await expect(readBoundedBody(bodyRequest({ 'content-length': '2' }, ['abc']), 8))
      .rejects.toMatchObject({ status: 400, message: 'Content-Length does not match the received body' })
  })
})

describe('replay adapter', () => {
  it('omits absent method and target and yields the buffered body once', async () => {
    const bare = replayableRequest({ headers: {} } as unknown as IncomingMessage, Buffer.from('body'))
    expect(Object.keys(bare)).toEqual(['headers', Symbol.asyncIterator].filter(key => typeof key === 'string'))
    const seen: Buffer[] = []
    for await (const chunk of bare) seen.push(chunk)
    expect(seen).toEqual([Buffer.from('body')])
  })

  it('carries the original method and target and yields nothing for an empty body', async () => {
    const empty = replayableRequest(
      { method: 'GET', url: '/mcp', headers: {} } as unknown as IncomingMessage,
      Buffer.alloc(0),
    )
    expect(empty.method).toBe('GET')
    expect(empty.url).toBe('/mcp')
    const seen: Buffer[] = []
    for await (const chunk of empty) seen.push(chunk)
    expect(seen).toEqual([])
  })
})

describe('chunk size bound', () => {
  it('bounds one chunk request by the result budget, not only by the caller request', () => {
    // Configuration guarantees defaultChunkBytes never exceeds the budget, so
    // the budget term only bites on the caller's own request — and without it a
    // max_bytes of 1 GB would make base64 and JSON encode the whole event.
    expect(chunkBytes(1_000_000_000, 900_000_000, 65_536, 1_048_576)).toBe(1_048_576)
    expect(chunkBytes(2_000_000, 900_000_000, 65_536, 1_048_576)).toBe(1_048_576)
    expect(chunkBytes(undefined, 900_000_000, 65_536, 1_048_576)).toBe(65_536)
    expect(chunkBytes(2048, 1024, 65_536, 1_048_576)).toBe(1024)
  })
})

/** Deployment settings a result-mapping case needs. */
function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    path: '/mcp',
    tokenRef: 'DSH_MCP_CONTROL_TOKEN',
    defaultMaxEvents: 128,
    maxEvents: 512,
    maxRequestBytes: 1_048_576,
    maxToolResultBytes: 4096,
    defaultChunkBytes: 2048,
    requestTimeoutMs: 25_000,
    ...overrides,
  }
}

/** Dependencies for the result helpers; no tool path here reads the context. */
function deps(overrides: Partial<ResolvedConfig> = {}): ControlDeps {
  return {
    ctx: {} as Context,
    config: config(overrides),
    unload: new AbortController().signal,
  }
}

describe('result mapping', () => {
  it('settles a native call at the deadline and consumes its later settlement', async () => {
    const controller = new AbortController()
    const started = new AbortController()
    const never = new Promise<never>((_resolve, reject) => {
      started.signal.addEventListener('abort', () => { reject(new Error('late native failure')) }, { once: true })
    })
    const raced = withinDeadline(never, controller.signal)
    const settled = controller.signal
    controller.abort(new Error('deadline elapsed'))
    await expect(raced).rejects.toThrow('deadline elapsed')
    expect(settled.aborted).toBe(true)
    // The abandoned native settlement is consumed, not rethrown globally.
    started.abort()

    const immediate = await withinDeadline(Promise.resolve('value'), new AbortController().signal)
    expect(immediate).toBe('value')
    const already = new AbortController()
    already.abort(new Error('already cancelled'))
    await expect(withinDeadline(Promise.resolve('value'), already.signal)).rejects.toThrow('already cancelled')
  })

  it('measures one value by its UTF-8 JSON bytes', () => {
    expect(jsonBytes({ a: 1 })).toBe(Buffer.byteLength('{"a":1}'))
    expect(jsonBytes({ text: '汉字' })).toBe(Buffer.byteLength(JSON.stringify({ text: '汉字' })))
  })

  it('returns identical data as structured content and as JSON text', () => {
    const result = okResult({ accepted: true })
    expect(result.structuredContent).toEqual({ accepted: true })
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ accepted: true })
  })

  it('keeps a failing payload inside the budget and degrades an oversized one to result-too-large', () => {
    const small = errorResult(deps(), 'session/not-found', 'no such session', { sessionId: 's-1' })
    expect(small.isError).toBe(true)
    expect(small.structuredContent).toEqual({
      error: { code: 'session/not-found', message: 'no such session', details: { sessionId: 's-1' } },
    })

    const large = errorResult(deps(), 'session/model-unavailable', 'x'.repeat(10_000), {
      session_id: 's-2',
      stage: 'prompt',
      receipt: 'unknown',
      dropped: 'y'.repeat(10_000),
      count: 3,
    })
    const error = (large.structuredContent as { error: { code: string; details: Record<string, unknown> } }).error
    expect(error.code).toBe('mcp-control/result-too-large')
    expect(error.details).toEqual({
      code: 'session/model-unavailable',
      session_id: 's-2',
      stage: 'prompt',
      receipt: 'unknown',
    })
    expect(jsonBytes(large)).toBeLessThanOrEqual(4096)
  })

  it('reports result-too-large when a successful value cannot fit', () => {
    const fits = okWithinBudget(deps(), { value: 'small' })
    expect(fits.isError).toBeUndefined()

    const oversized = okWithinBudget(deps(undefined), { root_session_id: 'r-1', entries: [{ pad: 'x'.repeat(10_000) }] })
    expect(oversized.isError).toBe(true)
    expect((oversized.structuredContent as { error: { code: string; details: Record<string, unknown> } }).error)
      .toMatchObject({ code: 'mcp-control/result-too-large', details: { root_session_id: 'r-1' } })
  })

  it('drops the largest correlation field first and names every field it dropped', () => {
    const large = '界'.repeat(256)
    const result = errorResult(deps(), 'subagent/parent-unavailable', 'no live parent', {
      request_id: large,
      parent_session_id: large,
      child_session_id: large,
    })
    const error = (result.structuredContent as { error: { details: Record<string, unknown> } }).error
    expect(jsonBytes(result)).toBeLessThanOrEqual(4096)
    // The three values cost the same, so the longest key is the largest field
    // and goes first; the two cheaper fields survive with the caller's ids.
    expect(error.details.omitted).toEqual(['parent_session_id'])
    expect(error.details).toMatchObject({
      code: 'subagent/parent-unavailable',
      request_id: large,
      child_session_id: large,
    })
  })

  it('keeps degrading to a code-only fallback when even one field cannot fit', () => {
    // Below the validated 4096-byte floor only the shape of the last
    // degradation step is observable; a validated budget never reaches it.
    const result = errorResult(deps({ maxToolResultBytes: 1 }), 'session/not-found', 'no such session', {
      session_id: 's-1',
      stage: 'prompt',
    })
    const error = (result.structuredContent as { error: { code: string; details: Record<string, unknown> } }).error
    expect(error.code).toBe('mcp-control/result-too-large')
    expect(error.details).toEqual({
      code: 'session/not-found',
      omitted: ['stage', 'session_id'],
    })
  })

  it('renders an issue path into the shortened diagnostic', () => {
    const [issue] = boundedIssues(deps(), 'session_cancel', [
      { path: ['session_id'], message: `Invalid input: ${'x'.repeat(8000)}` },
    ])
    expect(issue?.message).toContain('session_id: Invalid input:')
    expect(issue?.message).toContain('[truncated')
  })

  it('shortens a long validation diagnostic without cutting a surrogate pair', () => {
    const message = `Unrecognized key: "${'a'.repeat(4)}${'🙂'.repeat(2000)}"`
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u
    // Sweeping the budget moves the cut across the key, so every boundary is
    // measured, including one landing between the halves of a surrogate pair.
    for (let budget = 4096; budget < 4600; budget += 1) {
      const [issue] = boundedIssues(deps({ maxToolResultBytes: budget }), 'session_cancel', [{ message }])
      const text = issue?.message ?? ''
      expect(text).toContain('[truncated')
      expect(text).not.toMatch(loneSurrogate)
      // A lone surrogate would be replaced on the way to UTF-8; the text the
      // caller compares against its own argument must survive that round trip.
      expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text)
    }
  })

  it('presents the same validation and JSON Schema the wrapped schema declared', async () => {
    const schema = z.strictObject({ session_id: z.string().min(1) })
    const presented = boundedInputSchema(deps(), 'session_cancel', schema)
    // The SDK advertises this converter in `tools/list`, so it must be the
    // schema library's own conversion, not a second implementation.
    expect(presented['~standard'].jsonSchema)
      .toEqual(schema['~standard'].jsonSchema)
    await expect(presented['~standard'].validate({ session_id: 's-1' })).resolves.toEqual({ value: { session_id: 's-1' } })
    const failed = await presented['~standard'].validate({ session_id: 42 })
    // The SDK renders the path prefix itself; the wrapper only shortens text
    // that does not fit, so the original issues pass through unchanged here.
    expect(failed).toMatchObject({ issues: [{ path: ['session_id'] }] })
    const [fieldIssue] = (failed as { issues?: Array<{ message?: string }> }).issues ?? []
    expect(fieldIssue?.message).toContain('expected string')

    // An argument object whose own key name exceeds the whole budget still
    // produces a diagnostic the SDK can turn into a result inside that budget.
    const oversized = await presented['~standard'].validate({ session_id: 's-1', ['x'.repeat(9000)]: true })
    const issues = (oversized as { issues?: Array<{ message: string }> }).issues ?? []
    const text = issues.map(issue => issue.message).join(', ')
    expect(text).toContain('[truncated')
    expect(jsonBytes({ content: [{ type: 'text', text: `Input validation error: Invalid arguments for tool session_cancel: ${text}` }], isError: true }))
      .toBeLessThanOrEqual(4096)
  })
})

describe('failure classification', () => {
  it('maps this plugin deadline and a cancellation to request-timeout with an unknown receipt', async () => {
    using expired = deadline(undefined, 1, 'MCP_CONTROL_REQUEST_TIMEOUT')
    await vi.waitFor(() => { expect(expired.signal.aborted).toBe(true) })
    const timedOut = failureResult(deps(), new Error('late'), expired.signal, { session_id: 's-1' })
    expect(timedOut.structuredContent).toEqual({
      error: {
        code: 'mcp-control/request-timeout',
        message: 'the call ended before DSH confirmed its outcome',
        details: { session_id: 's-1', receipt: 'unknown' },
      },
    })
    const cancelled = new AbortController()
    cancelled.abort(new Error('client went away'))
    expect(failureResult(deps(), new Error('aborted'), cancelled.signal, {}).structuredContent)
      .toMatchObject({ error: { code: 'mcp-control/request-timeout', details: { receipt: 'unknown' } } })
  })

  it('preserves a native RemoteError and a SubagentError and hides anything else', () => {
    const native = failureResult(deps(), Object.assign(new Error('refused'), {
      isDSHRemoteError: true,
      code: 'session/conflict',
      details: { sessionId: 's-1' },
    }), new AbortController().signal, { request_id: 'r-1' })
    expect(native.structuredContent).toEqual({
      error: {
        code: 'session/conflict',
        message: 'refused',
        details: { request_id: 'r-1', sessionId: 's-1' },
      },
    })

    const subagent = failureResult(
      deps(),
      new SubagentError('listing failed', 'PROJECTIONS_UNAVAILABLE'),
      new AbortController().signal,
      { root_session_id: 'r-1' },
    )
    expect(subagent.structuredContent).toMatchObject({
      error: { code: 'PROJECTIONS_UNAVAILABLE', message: 'listing failed' },
    })

    const internal = failureResult(deps(), new Error('the database exploded'), new AbortController().signal, {})
    expect(internal.structuredContent).toEqual({
      error: { code: 'mcp-control/internal', message: 'the DSH operation failed', details: {} },
    })
    expect(JSON.stringify(internal)).not.toContain('database')
  })
})

describe('operation deadline', () => {
  it('aborts on the client signal and disposes its timer', () => {
    const client = new AbortController()
    const context = { mcpReq: { signal: client.signal } } as unknown as ServerContext
    using guard = operationDeadline(deps(), context)
    expect(guard.signal.aborted).toBe(false)
    client.abort(new Error('cancelled'))
    expect(guard.signal.aborted).toBe(true)
  })
})
