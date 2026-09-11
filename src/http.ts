/**
 * Loopback authority, bearer-token, and bounded-body intake for the exact
 * `/mcp` route. Every check here runs before the MCP SDK sees the request, so a
 * refused request never reaches a DSH service, and the body ceiling is applied
 * to the bytes actually received rather than to a declared length.
 *
 * @module @mochgolf/dsh-mcp-control
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/** HTTP refusal whose message carries no request data and is safe to return. */
export class ControlHttpError extends Error {
  override readonly name = 'ControlHttpError'

  /**
   * @param status - the HTTP status answer.
   * @param message - a fixed, credential-free diagnostic.
   */
  constructor(
    readonly status: 400 | 401 | 403 | 405 | 413 | 415,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Request headers that only a proxy or forwarder adds. This endpoint has no
 * reverse-proxy trust chain, so their presence means the request did not come
 * straight from a loopback client.
 */
const PROXY_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
] as const

/** Origin-header values a browser sends for a same-origin request to this endpoint. */
const SAME_ORIGIN_FETCH_SITES = new Set(['same-origin', 'none'])

/**
 * Require exactly one value for a header this guard interprets.
 * @param request - incoming request whose header table is read.
 * @param name - lowercase header name.
 * @param status - refusal status for an ambiguous or empty value; the authority guards answer 403 and the credential guard answers 401.
 * @returns the single value, or undefined when the header is absent.
 */
function singleHeader(request: IncomingMessage, name: string, status: 401 | 403 = 403): string | undefined {
  const values = request.headersDistinct[name]
  if (values === undefined) return undefined
  if (values.length !== 1) throw new ControlHttpError(status, `ambiguous ${name} header`)
  const value = values[0]
  if (value === undefined || value.trim() === '') throw new ControlHttpError(status, `empty ${name} header`)
  return value
}

/** Whether the raw request actually carries at least one value for `name`. */
function hasHeader(request: IncomingMessage, name: string): boolean {
  const value = request.headers[name]
  return value !== undefined && value !== ''
}

/**
 * Split one `Host` header into hostname and optional canonical decimal port.
 * @param value - the raw Host header value.
 * @returns the parsed authority, or undefined when it is not a bare host[:port].
 */
function parseAuthority(value: string): { hostname: string; port: number | undefined } | undefined {
  const match = /^([A-Za-z0-9.\-[\]]+)(?::(0|[1-9]\d*))?$/.exec(value)
  const hostname = match?.[1]
  if (hostname === undefined) return undefined
  const rawPort = match?.[2]
  if (rawPort === undefined) return { hostname, port: undefined }
  const port = Number(rawPort)
  if (!Number.isSafeInteger(port) || port > 65535) return undefined
  return { hostname, port }
}

/**
 * The exact `scheme://authority` origin this endpoint serves.
 * @param port - the listening port read from the shared WebServer.
 * @returns the origin that the same-origin check compares a presented Origin against.
 */
export function endpointOrigin(port: number): string {
  return `http://127.0.0.1:${String(port)}`
}

/**
 * Accept only the loopback authority this endpoint actually listens on, using
 * the header rather than any forwarding claim. A missing port means the default
 * HTTP port, which is correct only for an endpoint bound to port 80.
 * @param request - incoming request whose `Host` header is validated.
 * @param port - the listening port read from the shared WebServer.
 * @returns the endpoint origin the remaining checks compare against.
 * @throws {ControlHttpError} 403 for a missing, ambiguous, non-loopback, or wrong-port authority.
 */
export function assertLoopbackAuthority(request: IncomingMessage, port: number): string {
  const host = singleHeader(request, 'host')
  if (host === undefined) throw new ControlHttpError(403, 'missing Host header')
  const authority = parseAuthority(host)
  if (authority === undefined) throw new ControlHttpError(403, 'malformed Host header')
  if (authority.hostname !== '127.0.0.1') {
    throw new ControlHttpError(403, 'Host must name the loopback address 127.0.0.1')
  }
  if ((authority.port ?? 80) !== port) {
    throw new ControlHttpError(403, 'Host port does not match this endpoint')
  }
  return endpointOrigin(port)
}

/**
 * Reject browser cross-site calls and any forwarded request. A present `Origin`
 * must equal this endpoint exactly — `null`, another scheme, host, or port is
 * refused; a client that sends no `Origin` (the ordinary MCP client) passes.
 * @param request - incoming request whose browser and proxy headers are validated.
 * @param origin - the endpoint origin returned by {@link assertLoopbackAuthority}.
 * @throws {ControlHttpError} 403 for a cross-site, foreign, or forwarded request.
 */
export function assertSameOrigin(request: IncomingMessage, origin: string): void {
  for (const name of PROXY_HEADERS) {
    if (hasHeader(request, name)) {
      throw new ControlHttpError(403, `${name} is not accepted on a loopback endpoint`)
    }
  }
  const site = singleHeader(request, 'sec-fetch-site')
  if (site !== undefined && !SAME_ORIGIN_FETCH_SITES.has(site)) {
    throw new ControlHttpError(403, 'cross-site request refused')
  }
  const presented = singleHeader(request, 'origin')
  if (presented !== undefined && presented !== origin) {
    throw new ControlHttpError(403, 'Origin must equal this endpoint origin')
  }
}

/** RFC 6750 `b64token` syntax accepted after the `Bearer` authentication scheme. */
// oxlint-disable-next-line eslint/no-useless-escape -- a slash must be escaped inside a regex literal
const BEARER_TOKEN_SYNTAX = /^[A-Za-z0-9._~+\/-]+=*$/u

/**
 * Whether one value can be presented as a Bearer token at all. The configured
 * credential is checked with this same predicate, so a token no request could
 * ever present fails plugin activation instead of every request.
 * @param value - the candidate token value.
 * @returns true when the value uses the RFC 6750 `b64token` alphabet.
 */
export function canPresentAsBearer(value: string): boolean {
  return BEARER_TOKEN_SYNTAX.test(value)
}

/**
 * Read the presented bearer token. The value is returned for comparison only
 * and never logged, echoed, or persisted.
 * @param request - incoming request whose `Authorization` header is read.
 * @returns the presented token.
 * @throws {ControlHttpError} 401 for a missing or malformed Authorization header.
 */
export function presentedBearerToken(request: IncomingMessage): string {
  const header = singleHeader(request, 'authorization', 401)
  if (header === undefined) throw new ControlHttpError(401, 'missing Authorization header')
  const match = /^Bearer (.+)$/.exec(header)
  const token = match?.[1]
  if (token === undefined || !canPresentAsBearer(token)) {
    throw new ControlHttpError(401, 'Authorization must be a Bearer token')
  }
  return token
}

/**
 * Compare a presented token with the currently resolved credential in constant
 * time. Length is compared first, which the endpoint accepts as public; the
 * byte comparison itself never branches on content.
 * @param presented - token presented by the client.
 * @param expected - the credential value resolved for this request.
 * @returns true only when both are non-empty and byte-identical.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  const left = Buffer.from(presented, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.byteLength === 0 || left.byteLength !== right.byteLength) return false
  return timingSafeEqual(left, right)
}

/** Parse a decimal Content-Length or reject an ambiguous header. */
function declaredContentLength(request: IncomingMessage): number | undefined {
  const value = request.headers['content-length']
  if (value === undefined) return undefined
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new ControlHttpError(400, 'invalid Content-Length')
  const length = Number(value)
  if (!Number.isSafeInteger(length)) throw new ControlHttpError(413, 'request body is too large')
  return length
}

/**
 * Read one request body under an exact byte ceiling measured over the bytes
 * received, so a false or absent Content-Length cannot smuggle a larger body
 * past the check. A declared length that disagrees with what arrives is refused
 * rather than normalized.
 * @param request - incoming request before any parser consumes it.
 * @param maxRequestBytes - positive ceiling on the received body.
 * @returns the received bytes.
 * @throws {ControlHttpError} 400 for an aborted body or a length mismatch, 413 above the ceiling.
 */
export async function readBoundedBody(
  request: IncomingMessage,
  maxRequestBytes: number,
): Promise<Buffer> {
  const declared = declaredContentLength(request)
  if (declared !== undefined && declared > maxRequestBytes) {
    request.resume()
    throw new ControlHttpError(413, 'request body is too large')
  }

  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string)
      size += chunk.byteLength
      if (size > maxRequestBytes) {
        request.resume()
        throw new ControlHttpError(413, 'request body is too large')
      }
      chunks.push(chunk)
    }
  } catch (error: unknown) {
    if (error instanceof ControlHttpError) throw error
    throw new ControlHttpError(400, 'request body was aborted')
  }
  if (!request.complete) throw new ControlHttpError(400, 'request body was aborted')
  if (declared !== undefined && declared !== size) {
    throw new ControlHttpError(400, 'Content-Length does not match the received body')
  }
  return Buffer.concat(chunks, size)
}

/**
 * The request fields `toNodeHandler` reads. Supplying buffered bytes as an async
 * iterable lets the SDK's own Node adapter perform request and response
 * conversion while the ceiling stays enforced on the read.
 */
export interface ReplayableRequest {
  method?: string
  url?: string
  headers: IncomingMessage['headers']
  [Symbol.asyncIterator](): AsyncIterator<Buffer>
}

/**
 * Re-present an already-bounded body to the SDK's Node adapter.
 * @param request - the original incoming request.
 * @param body - the bytes already read under the ceiling.
 * @returns a request carrying the original method, target, and headers over the buffered body.
 */
export function replayableRequest(request: IncomingMessage, body: Buffer): ReplayableRequest {
  let delivered = body.byteLength === 0
  return {
    headers: request.headers,
    ...(request.method === undefined ? {} : { method: request.method }),
    ...(request.url === undefined ? {} : { url: request.url }),
    [Symbol.asyncIterator](): AsyncIterator<Buffer> {
      return {
        next(): Promise<IteratorResult<Buffer>> {
          if (delivered) return Promise.resolve({ done: true, value: undefined })
          delivered = true
          return Promise.resolve({ done: false, value: body })
        },
      }
    },
  }
}
