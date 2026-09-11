/**
 * Result, failure, and deadline handling shared by all seven tools. One place
 * decides how a native receipt becomes structured content, how a native failure
 * keeps its public code, and how the per-call deadline fuses client
 * cancellation, plugin unload, and the configured call timeout.
 *
 * @module @mochgolf/dsh-mcp-control
 */

import type { Context } from '@deepseek-ai/cordis'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { deadline, timeoutOf, type Deadline } from '@deepseek-ai/dsh-timeout'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { CallToolResult, ServerContext, StandardSchemaV1, StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { ResolvedConfig } from './config.ts'

/** Timeout code stamped on the per-call deadline's abort reason. */
const REQUEST_TIMEOUT_CODE = 'MCP_CONTROL_REQUEST_TIMEOUT'

/** Values every tool needs but none of them owns. */
export interface ControlDeps {
  /** Host context carrying the injected DSH services. */
  readonly ctx: Context
  /** Resolved deployment configuration. */
  readonly config: ResolvedConfig
  /** Aborted when the plugin unloads, fused into every operation signal. */
  readonly unload: AbortSignal
}

/**
 * Byte length of one JSON value as it is serialized to the wire.
 * @param value - the value to serialize exactly as the result carries it.
 * @returns the UTF-8 byte length of its JSON serialization.
 */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

/**
 * Successful result carrying identical data as structured content and as JSON text.
 * @param value - the tool's structured content.
 * @returns the complete CallToolResult.
 */
export function okResult(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}

/**
 * Largest prefix length whose complete result fits the byte budget, by binary
 * search over the monotonic prefix size.
 * @param count - the number of units available.
 * @param budget - the byte ceiling for the result the prefix produces.
 * @param sizeOf - byte size of the result carrying exactly this many units.
 * @returns the largest fitting count, or zero when even one unit does not fit.
 */
export function largestFittingPrefix(count: number, budget: number, sizeOf: (length: number) => number): number {
  if (count === 0) return 0
  if (sizeOf(count) <= budget) return count
  let low = 0
  let high = count
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (sizeOf(middle) <= budget) low = middle
    else high = middle - 1
  }
  return low
}

/** Small correlation fields preserved when a failure payload cannot fit the result budget. */
function correlateOnly(details: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string' && value.length <= 256 && (key.endsWith('_id') || key === 'stage' || key === 'receipt')) {
      kept[key] = value
    }
  }
  return kept
}

/** One failure result carrying a DSH or `mcp-control/*` code, message, and public details. */
function failureOf(code: string, message: string, details: Record<string, unknown>): CallToolResult {
  const error = { code, message, details }
  return {
    content: [{ type: 'text', text: JSON.stringify({ error }) }],
    structuredContent: { error },
    isError: true,
  }
}

/**
 * Build one tool failure. The DSH code, message, and public details pass through
 * unchanged; a payload that does not fit the result budget degrades to an
 * explicit `result-too-large` failure that keeps the correlation fields the
 * budget admits and names the ones it dropped, never a silently truncated copy
 * of the original.
 * @param deps - plugin dependencies carrying the result budget.
 * @param code - failure code, either a DSH code or an `mcp-control/*` code.
 * @param message - user-safe diagnostic.
 * @param details - public failure details.
 * @returns the failure result to return to the caller.
 */
export function errorResult(
  deps: ControlDeps,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): CallToolResult {
  const budget = deps.config.maxToolResultBytes
  const full = failureOf(code, message, details)
  if (jsonBytes(full) <= budget) return full

  // Rank the correlation fields by what each one costs, smallest first, so
  // every degradation step drops the field that frees the most budget and the
  // caller keeps the largest number of them; equal costs keep the order the
  // caller supplied.
  const ranked = Object.entries(correlateOnly(details))
    .map(([key, value]) => ({ key, value, bytes: jsonBytes([key, value]) }))
    .sort((left, right) => left.bytes - right.bytes)
  const degraded = (keep: number): CallToolResult => {
    const omitted = ranked.slice(keep).map(field => field.key)
    return failureOf('mcp-control/result-too-large', 'the failure payload exceeds the configured result budget', {
      code,
      ...Object.fromEntries(ranked.slice(0, keep).map(field => [field.key, field.value])),
      ...(omitted.length === 0 ? {} : { omitted }),
    })
  }
  let keep = ranked.length
  let fallback = degraded(keep)
  while (jsonBytes(fallback) > budget && keep > 0) {
    keep -= 1
    fallback = degraded(keep)
  }
  return fallback
}

/**
 * Build one successful result, or the explicit `result-too-large` failure when
 * the complete result does not fit the configured budget.
 * @param deps - plugin dependencies carrying the result budget.
 * @param value - the tool's structured content.
 * @returns the result to return to the caller.
 */
export function okWithinBudget(deps: ControlDeps, value: Record<string, unknown>): CallToolResult {
  const result = okResult(value)
  if (jsonBytes(result) <= deps.config.maxToolResultBytes) return result
  return errorResult(deps, 'mcp-control/result-too-large', 'the complete result exceeds the configured result budget', correlateOnly(value))
}

/**
 * Await one native call, settling with the operation deadline when it fires
 * first. A native operation that already entered asynchronous admission keeps
 * running after the deadline: the caller learns only that the outcome is
 * unknown, and the abandoned settlement is consumed so it cannot surface as an
 * unhandled rejection.
 * @param work - the native call already started.
 * @param signal - the fused operation signal.
 * @returns the native result when it settles inside the deadline.
 * @throws the signal's abort reason when the deadline or a cancellation wins.
 */
export async function withinDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  // The fused per-call signal carries this listener for the call's lifetime
  // only, so the one-shot registration needs no separate removal.
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
  })
  try {
    return await Promise.race([work, aborted])
  } finally {
    // The native operation keeps running after the deadline; its settlement is
    // consumed here so an abandoned rejection never surfaces process-wide.
    void work.catch(() => {})
  }
}

/**
 * Per-call deadline: client cancellation, plugin unload, and the call timeout, whichever fires first.
 * @param deps - plugin dependencies carrying the unload signal and call timeout.
 * @param context - the SDK's per-request context carrying the client's cancellation signal.
 * @returns the deadline guarding one tool call; dispose it to clear the timer.
 */
export function operationDeadline(deps: ControlDeps, context: ServerContext): Deadline {
  return deadline(
    AbortSignal.any([context.mcpReq.signal, deps.unload]),
    deps.config.requestTimeoutMs,
    REQUEST_TIMEOUT_CODE,
  )
}

/** The SDK's own rendering of one issue, mirrored so bounded text keeps its meaning. */
function renderIssue(issue: StandardSchemaV1.Issue): string {
  const path = issue.path
  /* v8 ignore next -- zod always reports a path array; the SDK type allows the omission for other Standard Schema libraries. */
  if (path === undefined || path.length === 0) return issue.message
  // A zod path segment is a property key; the SDK also accepts keyed objects
  // from other libraries, which these schemas cannot produce.
  return `${path.map(segment => String(segment as PropertyKey)).join('.')}: ${issue.message}`
}

/** The longest UTF-16 prefix that does not cut a surrogate pair in half. */
function codePointPrefix(text: string, length: number): string {
  const last = text.charCodeAt(length - 1)
  const endsMidPair = length > 0 && last >= 0xd800 && last <= 0xdbff
  return text.slice(0, endsMidPair ? length - 1 : length)
}

/**
 * Bound the diagnostic of one failed input validation. The SDK renders a failed
 * validation as a tool error whose text is this schema's own issues, so a
 * hostile argument object — an unrecognized key with a very long name, for
 * instance — would otherwise make that SDK-built CallToolResult exceed the
 * declared budget. Enforcement stays in the SDK's validation step; only the
 * text is shortened, and the shortened text names the size it replaced.
 * @param deps - plugin dependencies carrying the result budget.
 * @param toolName - the registered tool whose arguments failed validation.
 * @param issues - the issues the underlying schema reported.
 * @returns the issues to report, with their rendered diagnostic inside the budget.
 */
export function boundedIssues(
  deps: ControlDeps,
  toolName: string,
  issues: readonly StandardSchemaV1.Issue[],
): StandardSchemaV1.Issue[] {
  const budget = deps.config.maxToolResultBytes
  const prefix = `Input validation error: Invalid arguments for tool ${toolName}: `
  // The SDK answers a failed validation with exactly this text-only result, so
  // its byte size is known here rather than guessed.
  const sizeOf = (text: string): number => jsonBytes({
    content: [{ type: 'text', text: `${prefix}${text}` }],
    isError: true,
  })
  const rendered = issues.map(renderIssue).join(', ')
  if (sizeOf(rendered) <= budget) return [...issues]
  const note = ` …[truncated: the complete diagnostic is ${String(Buffer.byteLength(`${prefix}${rendered}`, 'utf8'))} bytes]`
  const length = largestFittingPrefix(rendered.length, budget, count => sizeOf(`${codePointPrefix(rendered, count)}${note}`))
  return [{ message: `${codePointPrefix(rendered, length)}${note}` }]
}

/**
 * Present one tool's arguments to the SDK with a bounded validation diagnostic.
 * The caller's zod schema still validates and still advertises the same JSON
 * Schema; the SDK still rejects invalid arguments before the handler runs. Only
 * the size of the message it builds from those issues is capped, which is the
 * one SDK-produced CallToolResult this plugin's own result builders cannot see.
 * @param deps - plugin dependencies carrying the result budget.
 * @param toolName - the tool name the SDK reports in its validation error.
 * @param schema - the zod schema describing this tool's arguments.
 * @returns the schema to register, with identical validation and JSON Schema.
 */
export function boundedInputSchema<T extends z.ZodType>(
  deps: ControlDeps,
  toolName: string,
  schema: T,
): StandardSchemaWithJSON<z.input<T>, z.output<T>> {
  const base = schema['~standard']
  return {
    '~standard': {
      version: 1,
      vendor: 'dsh-mcp-control',
      types: base.types,
      // The schema library's own converter, so `tools/list` advertises exactly
      // the JSON Schema this schema published before it was wrapped.
      jsonSchema: base.jsonSchema,
      validate: async (value) => {
        const result = await base.validate(value)
        /* v8 ignore next -- zod reports issues for every failed validation; the SDK type
           allows their omission for other Standard Schema libraries. */
        if (!('issues' in result) || result.issues === undefined) return result
        return { issues: boundedIssues(deps, toolName, result.issues) }
      },
    },
  }
}

/**
 * Map one failed native call onto a tool failure. A native rejection keeps its
 * own code and message; this plugin's deadline, a client cancellation, or an
 * unload becomes `request-timeout` with an explicitly unknown receipt, because
 * DSH may already have accepted the operation. Anything else is reported as
 * `mcp-control/internal` without leaking the exception object.
 * @param deps - plugin dependencies carrying the result budget.
 * @param error - the value the native call rejected with.
 * @param signal - the operation signal, read for timeout and abort facts.
 * @param correlation - small identifiers that locate the operation for the caller.
 * @returns the failure result to return to the caller.
 */
export function failureResult(
  deps: ControlDeps,
  error: unknown,
  signal: AbortSignal,
  correlation: Record<string, string>,
): CallToolResult {
  if (timeoutOf(signal) !== undefined) {
    return errorResult(deps, 'mcp-control/request-timeout', 'the call ended before DSH confirmed its outcome', {
      ...correlation,
      receipt: 'unknown',
    })
  }
  const native = remoteErrorOf(error)
  if (native !== undefined) {
    return errorResult(deps, native.code, native.message, { ...correlation, ...native.details })
  }
  if (error instanceof SubagentError) {
    return errorResult(deps, error.code, error.message, correlation)
  }
  if (signal.aborted) {
    return errorResult(deps, 'mcp-control/request-timeout', 'the call ended before DSH confirmed its outcome', {
      ...correlation,
      receipt: 'unknown',
    })
  }
  return errorResult(deps, 'mcp-control/internal', 'the DSH operation failed', correlation)
}
