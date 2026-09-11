/**
 * `events_read`: forward-only, lossless paging over the durable raw Session
 * event log, plus a chunk mode that retrieves one oversized event in pieces
 * through the same tool. The page never advances past an event it did not
 * deliver whole, never activates a cold root, and keeps no listener, cursor,
 * snapshot, or cache between requests — the caller's `after_seq` is the only
 * cursor that exists.
 *
 * @module @mochgolf/dsh-mcp-control
 */

import { createHash } from 'node:crypto'
import type {
  SessionAddress,
  SessionHistoryRecord,
  SessionWireEvent,
  SessionWireHeader,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { bytesToBase64 } from '@deepseek-ai/dsh-util-crypto'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  boundedInputSchema,
  errorResult,
  failureResult,
  jsonBytes,
  largestFittingPrefix,
  okResult,
  operationDeadline,
  withinDeadline,
  type ControlDeps,
} from './result.ts'

/** Message-aligned page budget for the opening observation: the smallest window the snapshot can return. */
const OPENING_MAX_MESSAGES = 1

/** One opaque durable identity accepted from a client. */
const opaqueId = z.string().min(1).max(256)

/** Durable address of one root Session or one direct subagent child. */
const addressSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), session_id: opaqueId }),
  z.strictObject({
    kind: z.literal('subagent'),
    parent_session_id: opaqueId,
    child_session_id: opaqueId,
    mode: z.enum(['one-shot', 'continuable']),
  }),
])

/** Forward page request; `mode` may be omitted, which means `page`. */
const pageSchema = z.strictObject({
  mode: z.literal('page').optional(),
  address: addressSchema,
  after_seq: z.number().int().min(-1).default(-1),
  max_events: z.number().int().min(1).optional(),
})

/** Chunk request for one event whose page delivery exceeded the result budget. */
const chunkSchema = z.strictObject({
  mode: z.literal('chunk'),
  address: addressSchema,
  event_seq: z.number().int().min(0),
  offset: z.number().int().min(0),
  max_bytes: z.number().int().min(1).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})

/** Raw event as it crosses the MCP wire: every native field is relayed unchanged. */
const eventSchema = z.record(z.string(), z.unknown())

/** Descriptor for one event too large to deliver inside a page. */
const oversizedSchema = z.object({
  seq: z.number(),
  byte_length: z.number(),
  sha256: z.string(),
})

const pageOutputSchema = z.object({
  mode: z.literal('page'),
  header: z.record(z.string(), z.unknown()),
  head_seq: z.number(),
  next_seq: z.number(),
  events: z.array(eventSchema),
  has_more: z.boolean(),
  oversized_event: oversizedSchema.optional(),
})

const chunkOutputSchema = z.object({
  mode: z.literal('chunk'),
  event_seq: z.number(),
  encoding: z.literal('base64'),
  data: z.string(),
  offset: z.number(),
  next_offset: z.number(),
  byte_length: z.number(),
  sha256: z.string(),
  done: z.boolean(),
})

/** Map one validated MCP address onto the native durable address. */
function nativeAddress(address: z.infer<typeof addressSchema>): SessionAddress {
  if (address.kind === 'session') {
    return { kind: 'session', sessionId: SessionId(address.session_id) }
  }
  return {
    kind: 'subagent',
    parentSessionId: SessionId(address.parent_session_id),
    childSessionId: SessionId(address.child_session_id),
    mode: address.mode,
  }
}

/** The opening observation of one durable address: header, watermark, and its trailing window. */
interface OpeningSnapshot {
  readonly header: SessionWireHeader
  readonly cursor: number
  readonly records: readonly SessionHistoryRecord[]
}

/**
 * Take exactly one frame from `follow` and close the iterator. The ordinary
 * Session promotion this generator performs runs after its first yield, so
 * returning immediately keeps the read cold; the `finally` block releases the
 * observation, the listeners, and the caller's signal handler.
 */
async function openingSnapshot(
  deps: ControlDeps,
  address: SessionAddress,
  signal: AbortSignal,
): Promise<OpeningSnapshot> {
  const iterator = deps.ctx.sessionController.follow(
    { address, maxMessages: OPENING_MAX_MESSAGES },
    signal,
  )[Symbol.asyncIterator]()
  try {
    const frame = await withinDeadline(iterator.next(), signal)
    /* v8 ignore next 3 -- follow's documented first frame is always the opening snapshot, built before any other frame can be produced. */
    if (frame.done === true || frame.value.type !== 'snapshot') {
      throw new Error('session follow did not open with a snapshot frame')
    }
    return { header: frame.value.header, cursor: frame.value.cursor, records: frame.value.records }
  } finally {
    await iterator.return?.()
  }
}

/** Events of one record window, limited to the half-open sequence interval the caller asked for. */
function windowEvents(
  records: readonly SessionHistoryRecord[],
  afterSeq: number,
  endSeq: number,
): SessionWireEvent[] {
  const events: SessionWireEvent[] = []
  for (const record of records) {
    if (record.event.seq > afterSeq && record.event.seq <= endSeq) events.push(record.event)
  }
  return events
}

/** Hex SHA-256 and UTF-8 byte length of one event's JSON serialization. */
function eventDigest(event: SessionWireEvent): { bytes: Buffer; sha256: string; byteLength: number } {
  const bytes = Buffer.from(JSON.stringify(event), 'utf8')
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength }
}

/**
 * Event bytes one chunk request may encode: the caller's `max_bytes` (or the
 * configured default), the bytes left after `offset`, and the complete-result
 * budget. The budget belongs in this bound rather than only in the size search
 * because base64 and JSON encoding allocate several times the slice before any
 * size is measured, so an unbounded slice costs memory the result never uses.
 * @param maxBytes - the caller's requested chunk size, when supplied.
 * @param remaining - event bytes left from `offset` to the end.
 * @param fallback - chunk size used when the caller omitted `max_bytes`.
 * @param budget - ceiling on one complete `CallToolResult`.
 * @returns the number of event bytes this request may read.
 */
export function chunkBytes(
  maxBytes: number | undefined,
  remaining: number,
  fallback: number,
  budget: number,
): number {
  return Math.min(maxBytes ?? fallback, budget, remaining)
}

/** Answer one forward page request. */
async function readPage(
  deps: ControlDeps,
  input: z.infer<typeof pageSchema>,
  signal: AbortSignal,
): Promise<ReturnType<typeof okResult>> {
  const address = nativeAddress(input.address)
  const afterSeq = input.after_seq
  let snapshot: OpeningSnapshot
  try {
    snapshot = await openingSnapshot(deps, address, signal)
  } catch (error: unknown) {
    return failureResult(deps, error, signal, {})
  }
  const head = snapshot.cursor
  if (afterSeq > head) {
    return errorResult(deps, 'mcp-control/cursor-ahead', 'after_seq is past the current log watermark', {
      after_seq: String(afterSeq),
      head_seq: String(head),
    })
  }
  const emit = (delivered: SessionWireEvent[], oversized?: Record<string, unknown>): Record<string, unknown> => {
    const last = delivered.at(-1)
    const nextSeq = last === undefined ? afterSeq : last.seq
    return {
      mode: 'page',
      header: snapshot.header,
      head_seq: head,
      next_seq: nextSeq,
      events: delivered,
      has_more: nextSeq < head,
      ...(oversized === undefined ? {} : { oversized_event: oversized }),
    }
  }
  const budget = deps.config.maxToolResultBytes
  // The header is part of every page, including an empty one, so it is measured
  // before the empty-page shortcut can answer with a result over the budget.
  const empty = emit([])
  if (jsonBytes(okResult(empty)) > budget) {
    return errorResult(deps, 'mcp-control/result-too-large', 'the page header alone exceeds the configured result budget', {})
  }
  if (head === -1 || afterSeq === head) return okResult(empty)

  const limit = Math.min(input.max_events ?? deps.config.defaultMaxEvents, deps.config.maxEvents)
  const endSeq = afterSeq + Math.min(limit, head - afterSeq)
  const openingFirst = snapshot.records[0]?.event.seq
  let candidates: SessionWireEvent[]
  if (openingFirst !== undefined && openingFirst <= afterSeq + 1) {
    candidates = windowEvents(snapshot.records, afterSeq, endSeq)
  } else {
    try {
      const page = await withinDeadline(deps.ctx.sessionController.page({
        address,
        throughSeq: head,
        beforeSeq: endSeq + 1,
        maxMessages: limit,
      }, signal), signal)
      candidates = windowEvents(page.records, afterSeq, endSeq)
    } catch (error: unknown) {
      return failureResult(deps, error, signal, { after_seq: String(afterSeq) })
    }
  }

  const length = largestFittingPrefix(candidates.length, budget, count => jsonBytes(okResult(emit(candidates.slice(0, count)))))
  if (length === 0 && candidates.length > 0) {
    const first = candidates[0] as SessionWireEvent
    const digest = eventDigest(first)
    const oversized = { seq: first.seq, byte_length: digest.byteLength, sha256: digest.sha256 }
    const value = emit([], oversized)
    if (jsonBytes(okResult(value)) > budget) {
      return errorResult(deps, 'mcp-control/result-too-large', 'the oversized-event descriptor exceeds the configured result budget', {
        event_seq: String(first.seq),
      })
    }
    return okResult(value)
  }
  return okResult(emit(candidates.slice(0, length)))
}

/** Read one complete event back from the same native address. */
async function readEvent(
  deps: ControlDeps,
  address: SessionAddress,
  seq: number,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; sha256: string }> {
  const page = await withinDeadline(deps.ctx.sessionController.page({
    address,
    throughSeq: seq,
    beforeSeq: seq + 1,
    maxMessages: OPENING_MAX_MESSAGES,
  }, signal), signal)
  const event = page.records.at(-1)?.event
  /* v8 ignore next 3 -- the controller validates the dense zero-based prefix and refuses a through seq it cannot serve. */
  if (event === undefined || event.seq !== seq) {
    throw new Error(`the log served no event at seq ${String(seq)}`)
  }
  const digest = eventDigest(event)
  return { bytes: digest.bytes, sha256: digest.sha256 }
}

/** Answer one chunk request for an event a page could not deliver whole. */
async function readChunk(
  deps: ControlDeps,
  input: z.infer<typeof chunkSchema>,
  signal: AbortSignal,
): Promise<ReturnType<typeof okResult>> {
  const address = nativeAddress(input.address)
  const seq = input.event_seq
  let read: { bytes: Buffer; sha256: string }
  try {
    read = await readEvent(deps, address, seq, signal)
  } catch (error: unknown) {
    return failureResult(deps, error, signal, { event_seq: String(seq) })
  }
  if (read.sha256 !== input.sha256) {
    return errorResult(deps, 'mcp-control/event-changed', 'the event no longer matches the page descriptor; read the page again', {
      event_seq: String(seq),
      sha256: read.sha256,
    })
  }
  const offset = input.offset
  if (offset > read.bytes.byteLength) {
    return errorResult(deps, 'mcp-control/invalid-offset', 'offset is past the end of the event', {
      event_seq: String(seq),
      byte_length: String(read.bytes.byteLength),
    })
  }
  const budget = deps.config.maxToolResultBytes
  const requested = chunkBytes(input.max_bytes, read.bytes.byteLength - offset, deps.config.defaultChunkBytes, budget)
  const build = (length: number): Record<string, unknown> => {
    const nextOffset = offset + length
    return {
      mode: 'chunk',
      event_seq: seq,
      encoding: 'base64',
      data: bytesToBase64(read.bytes.subarray(offset, nextOffset)),
      offset,
      next_offset: nextOffset,
      byte_length: read.bytes.byteLength,
      sha256: read.sha256,
      done: nextOffset >= read.bytes.byteLength,
    }
  }
  const length = largestFittingPrefix(requested, budget, count => jsonBytes(okResult(build(count))))
  /* v8 ignore next 5 -- the validated budget floor (4096 bytes) always admits the empty chunk envelope. */
  if (length === 0 && requested > 0) {
    return errorResult(deps, 'mcp-control/result-too-large', 'no chunk of this event fits the configured result budget', {
      event_seq: String(seq),
    })
  }
  return okResult(build(length))
}

/**
 * Register `events_read` with its page and chunk request forms.
 * @param server - the request-scoped MCP server.
 * @param deps - plugin dependencies carrying the Session Controller and limits.
 */
export function registerEventsRead(server: McpServer, deps: ControlDeps): void {
  server.registerTool(
    'events_read',
    {
      title: 'Read durable DSH session events',
      description:
        'Read the durable raw event log of a root session or one addressed subagent child, forward from after_seq (default -1, the first event). '
        + 'Events are relayed exactly as DSH exposes them, including tool results, metadata, sourceEventSeqs, and ignorable markers; the page stops at a fixed watermark '
        + 'and never activates a cold session. An event too large for one result is reported as oversized_event with its byte length and sha256, then retrieved with '
        + 'mode "chunk" using the same address; concatenate the base64 chunks, verify the sha256, and parse the bytes as UTF-8 JSON to recover the exact event.',
      inputSchema: boundedInputSchema(deps, 'events_read', z.union([chunkSchema, pageSchema])),
      outputSchema: z.union([chunkOutputSchema, pageOutputSchema]),
      annotations: { readOnlyHint: true },
    },
    async (args, context) => {
      using guard = operationDeadline(deps, context)
      return args.mode === 'chunk'
        ? await readChunk(deps, args, guard.signal)
        : await readPage(deps, args, guard.signal)
    },
  )
}
