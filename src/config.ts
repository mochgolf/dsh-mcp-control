/**
 * Deployment configuration for the `/mcp` control endpoint. Everything here is
 * a value a deployment genuinely changes; the tool set, the loopback-only bind,
 * and the lossless raw-event pass-through are fixed.
 *
 * @module @mochgolf/dsh-mcp-control
 */

import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'

/** Smallest result budget that still admits an error and one non-empty chunk. */
const MIN_RESULT_BYTES = 4096

/** Paths the shared WebServer or its browser API already owns. */
const RESERVED_PATHS = new Set(['/', '/api'])

/** mcp-control deployment settings; every optional field carries the documented default. */
export interface Config {
  /** Exact route path this endpoint registers on the shared WebServer. @default '/mcp' */
  readonly path?: string
  /** Credential reference holding the bearer token; never the token itself. */
  readonly tokenRef: string
  /** Events returned when a page request omits `max_events`. @default 128 */
  readonly defaultMaxEvents?: number
  /** Largest `max_events` one page request may ask for. @default 512 */
  readonly maxEvents?: number
  /** Ceiling on the bytes actually received for one request body. @default 1048576 */
  readonly maxRequestBytes?: number
  /** Ceiling on one complete CallToolResult, text fallback and structured content included. @default 1048576 */
  readonly maxToolResultBytes?: number
  /** Raw event bytes one chunk returns when `max_bytes` is omitted. @default 65536 */
  readonly defaultChunkBytes?: number
  /** Ceiling on one MCP call, excluding the lifetime of work DSH already accepted. @default 25000 */
  readonly requestTimeoutMs?: number
}

/** Complete config after schemastery applies every field default. */
export type ResolvedConfig = Required<Config>

/** Validated mcp-control configuration; every field carries its documented default. */
export const Config: z<Config> = z.object({
  path: z.string().default('/mcp'),
  tokenRef: z.string().role('credential-ref').required(),
  defaultMaxEvents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(128),
  maxEvents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(512),
  maxRequestBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1048576),
  maxToolResultBytes: z.number().step(1).min(MIN_RESULT_BYTES).max(Number.MAX_SAFE_INTEGER).default(1048576),
  defaultChunkBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(65536),
  requestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(25000),
})

/**
 * Reject configuration facts a field schema cannot express. A misconfigured
 * endpoint fails at load rather than at the first request.
 * @param config - the resolved configuration.
 * @throws Error when the path is not a canonical single-segment absolute pathname, targets a reserved path, or the event bounds disagree.
 */
export function assertConfig(config: ResolvedConfig): void {
  const { path } = config
  if (!path.startsWith('/') || path === '/' || path.endsWith('/') || path.includes('?') || path.includes('#')) {
    throw new Error('mcp-control path must be an absolute pathname without a trailing slash, query, or fragment')
  }
  if (path.slice(1).includes('/')) {
    throw new Error('mcp-control path must be a single path segment')
  }
  // The WebServer matches the normalized `pathname` of the request target, so a
  // path spelled any other way registers successfully and then never matches.
  const canonical = new URL(path, 'http://x').pathname
  if (canonical !== path) {
    throw new Error(`mcp-control path "${path}" is not the canonical pathname "${canonical}" the WebServer matches`)
  }
  if (RESERVED_PATHS.has(path)) {
    throw new Error(`mcp-control path "${path}" is reserved by the Web surface`)
  }
  if (config.maxEvents < config.defaultMaxEvents) {
    throw new Error('mcp-control maxEvents must be at least defaultMaxEvents')
  }
  if (config.defaultChunkBytes > config.maxToolResultBytes) {
    throw new Error('mcp-control defaultChunkBytes must not exceed maxToolResultBytes')
  }
}
