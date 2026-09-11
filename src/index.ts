/**
 * `mcp-control` — an opt-in MCP control endpoint on the shared WebServer's
 * exact route. It exposes seven tools that start, steer, cancel, list, and read
 * already-known DSH Sessions through the native Session Controller and subagent
 * services; it owns no task state, starts no second listener, and never
 * bypasses DSH authority. Loading fails loudly on a non-loopback WebServer
 * bind, an unset credential, invalid configuration, or a route collision.
 *
 * @module @mochgolf/dsh-mcp-control
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-subagent'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { assertConfig, type Config, type ResolvedConfig } from './config.ts'
import {
  assertLoopbackAuthority,
  assertSameOrigin,
  canPresentAsBearer,
  ControlHttpError,
  presentedBearerToken,
  readBoundedBody,
  replayableRequest,
  tokenMatches,
} from './http.ts'
import type { ControlDeps } from './result.ts'
import { createControlServer } from './tools.ts'

/** Cordis function-plugin name. */
export const name = 'mcp-control'
/** Host services required before the endpoint can register. */
export const inject = ['webServer', 'sessionController', 'subagents', 'credentials']

export { Config } from './config.ts'

/** Methods whose request carries no body, matching the SDK's own Node adapter. */
const BODYLESS_METHODS = new Set(['GET', 'HEAD'])

/** An empty body for a bodiless method. */
const EMPTY_BODY = Buffer.alloc(0)

/**
 * One request this plugin admitted, from its first header byte to the end of
 * its response. Ownership moves as the request advances — this plugin owns
 * intake, the tool call runs under the per-call deadline, and the SDK owns the
 * response write — but the socket stays this plugin's to end: a client that
 * stops reading leaves the SDK's write awaiting a drain that never arrives, so
 * an unload that only waited would wait forever.
 */
interface InFlightRequest {
  /** Settles once the request has been answered, refused, or terminated. */
  readonly settled: Promise<void>
  /** Ends this request's own socket so neither intake nor a blocked write can outlive the endpoint. */
  readonly terminate: () => void
}

/**
 * Settle one admission step against the plugin's unload. The credential
 * provider and the client's own body stream have no cancellation path, so
 * without this race a half-sent request would outlive the endpoint that is
 * unloading. The abandoned step keeps running and can no longer answer: the
 * caller already destroyed the request's socket.
 *
 * The route is unregistered before the unload signal aborts, so this never runs
 * against a signal that has already fired.
 * @param work - the admission step already started.
 * @param unload - the plugin's unload signal.
 * @returns the step's result when it settles first.
 */
function untilUnload<T>(work: Promise<T>, unload: AbortSignal): Promise<T> {
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => { reject(unload.reason as Error) }
    unload.addEventListener('abort', onAbort, { once: true })
    // The listener belongs to this admission step: a step that settles first
    // removes it, and consuming the abandoned rejection here keeps it from
    // surfacing process-wide.
    void work.then(
      () => { unload.removeEventListener('abort', onAbort) },
      () => { unload.removeEventListener('abort', onAbort) },
    )
  })
  return Promise.race([work, aborted])
}

/**
 * Build the exact-route handler: authority and origin, then the credential
 * resolved for this request alone, then the bounded body, and only then the MCP
 * SDK. Every refusal here happens before a DSH service is reachable. Intake
 * steps without their own cancellation path settle against the unload signal;
 * the response the SDK writes is ended by {@link InFlightRequest.terminate}
 * instead, because a client that stopped reading cannot be waited out.
 */
function createRequestHandler(
  deps: ControlDeps,
  tokenRef: ReturnType<typeof credentialRef>,
  port: number,
  dispatch: (request: Parameters<WebRoute['handler']>[0], response: Parameters<WebRoute['handler']>[1], body: Buffer) => Promise<void>,
): (request: Parameters<WebRoute['handler']>[0], response: Parameters<WebRoute['handler']>[1]) => Promise<void> {
  return async (request, response) => {
    try {
      assertSameOrigin(request, assertLoopbackAuthority(request, port))
      const credential = await untilUnload(deps.ctx.credentials.resolve(tokenRef), deps.unload)
      if (credential === undefined || credential.value === '') {
        throw new ControlHttpError(401, 'the endpoint credential is not configured')
      }
      if (!tokenMatches(presentedBearerToken(request), credential.value)) {
        throw new ControlHttpError(401, 'invalid bearer token')
      }
      /* v8 ignore next -- node:http always sets a method on server requests; the field is optional only on the client-side type. */
      const method = (request.method ?? 'GET').toUpperCase()
      const body = BODYLESS_METHODS.has(method)
        ? EMPTY_BODY
        : await untilUnload(readBoundedBody(request, deps.config.maxRequestBytes), deps.unload)
      await dispatch(request, response, body)
    } catch (error: unknown) {
      if (deps.unload.aborted) {
        response.destroy()
        return
      }
      /* v8 ignore next 4 -- every guard above answers before a response byte is written; the SDK adapter owns post-write failures. */
      if (response.headersSent) {
        response.destroy()
        return
      }
      const status = error instanceof ControlHttpError ? error.status : 503
      const message = error instanceof ControlHttpError ? error.message : 'the MCP endpoint is unavailable'
      response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(message)
    }
  }
}

/**
 * Register the `/mcp` route on the shared WebServer.
 * @param ctx - host context carrying the injected services.
 * @param config - resolved and validated deployment configuration.
 * @throws Error when the WebServer is not loopback-bound, the credential is unset, the configuration is invalid, or the route is taken.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertConfig(resolved)
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error('mcp-control requires a loopback-bound WebServer (host 127.0.0.1)')
  }
  const tokenRef = credentialRef(resolved.tokenRef)
  const credential = await ctx.credentials.resolve(tokenRef)
  if (credential === undefined || credential.value === '') {
    throw new Error(`mcp-control credential "${resolved.tokenRef}" is not configured`)
  }
  // A credential the request path could never accept would otherwise load a
  // healthy-looking endpoint that answers 401 to every request.
  if (!canPresentAsBearer(credential.value)) {
    throw new Error(`mcp-control credential "${resolved.tokenRef}" must be an RFC 6750 Bearer token using the b64token alphabet`)
  }

  const unload = new AbortController()
  const deps: ControlDeps = { ctx, config: resolved, unload: unload.signal }
  const inFlight = new Set<InFlightRequest>()
  const report = (error: Error): void => { ctx.logger.warn('mcp-control: %s', error.message) }
  const handler = createMcpHandler(() => createControlServer(deps), { legacy: 'stateless', onerror: report })
  const nodeHandler = toNodeHandler(handler, { onerror: report })
  const port = ctx.webServer.port
  const serve = createRequestHandler(deps, tokenRef, port, async (request, response, body) => {
    await nodeHandler(replayableRequest(request, body), response)
  })

  const route: WebRoute = {
    kind: 'exact',
    path: resolved.path,
    handler: (request, response) => {
      const entry: InFlightRequest = {
        // The handler answers every refusal itself, so this settlement is the
        // request's own completion rather than a rejection.
        settled: serve(request, response),
        terminate: () => {
          request.destroy()
          /* v8 ignore next -- only an unload landing inside the settlement microtask sees an already flushed response. */
          if (!response.writableFinished) response.destroy()
        },
      }
      const released = (): void => { inFlight.delete(entry) }
      inFlight.add(entry)
      void entry.settled.then(released, released)
      return entry.settled
    },
  }

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register(route)
    return async () => {
      disposeRoute()
      unload.abort(new Error('mcp-control unloaded'))
      // Every request admitted before the route came down is ended here rather
      // than awaited as-is: a client that stopped reading holds a response
      // write open indefinitely, and unloading must not depend on that client.
      // Ending the socket settles the SDK write; DSH work the call already
      // accepted keeps running on its own, untouched by this loop.
      for (const entry of inFlight) entry.terminate()
      await Promise.allSettled([...inFlight].map(entry => entry.settled))
      await handler.close()
    }
  }, `mcp-control: ${resolved.path}`)
}
