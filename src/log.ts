/**
 * Durable log reads shared by the read tools: the address schema, the
 * non-activating opening observation, and a backward tail read. Every read
 * goes through the Session Controller's own address validation and never makes
 * a cold Session live.
 *
 * @module @mochgolf/dsh-mcp-control
 */

import type {
  SessionAddress,
  SessionHistoryRecord,
  SessionWireEvent,
  SessionWireHeader,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import { withinDeadline, type ControlDeps } from './result.ts'

/** Message-aligned page budget for the opening observation: the smallest window the snapshot can return. */
export const OPENING_MAX_MESSAGES = 1

/** Messages the first backward tail page asks for; later pages double it. */
const TAIL_FIRST_PAGE_MESSAGES = 64

/** One opaque durable identity accepted from a client. */
export const opaqueId = z.string().min(1).max(256)

/** Durable address of one root Session or one direct subagent child. */
export const addressSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), session_id: opaqueId }),
  z.strictObject({
    kind: z.literal('subagent'),
    parent_session_id: opaqueId,
    child_session_id: opaqueId,
    mode: z.enum(['one-shot', 'continuable']),
  }),
])

/** A validated MCP address. */
export type Address = z.infer<typeof addressSchema>

/** Map one validated MCP address onto the native durable address. */
export function nativeAddress(address: Address): SessionAddress {
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

/** The Session the address names: the root itself, or the addressed child. */
export function addressedSessionId(address: Address): SessionId {
  return SessionId(address.kind === 'session' ? address.session_id : address.child_session_id)
}

/** The address's identity fields, echoed in results and failure correlation. */
export function addressCorrelation(address: Address): Record<string, string> {
  return address.kind === 'session'
    ? { session_id: address.session_id }
    : { parent_session_id: address.parent_session_id, child_session_id: address.child_session_id }
}

/** One prompt waiting in a Session's inbox, as the durable inbox projection holds it. */
export interface PendingPrompt {
  readonly id: string
  readonly delivery: 'queue' | 'steer'
  readonly source?: unknown
  readonly content: readonly unknown[]
}

/** The opening observation of one durable address: header, watermark, its trailing window, and its inbox. */
export interface OpeningSnapshot {
  readonly header: SessionWireHeader
  readonly cursor: number
  readonly records: readonly SessionHistoryRecord[]
  /**
   * Prompts the durable inbox projection holds at the watermark — the same
   * cut as `cursor`, and present whether or not an Agent is loaded; undefined
   * when no inbox projection is registered.
   */
  readonly inbox: readonly PendingPrompt[] | undefined
}

/** The pending prompts one inbox projection value lists, steering prompts first. */
function inboxOf(values: Readonly<Record<string, unknown>> | undefined): PendingPrompt[] | undefined {
  const inbox = values?.inbox as { readonly 'next-turn'?: unknown; readonly 'next-step'?: unknown } | null | undefined
  if (inbox === undefined || inbox === null) return undefined
  const prompts = (entries: unknown, delivery: PendingPrompt['delivery']): PendingPrompt[] => {
    /* v8 ignore next -- the inbox projection always carries both pending lists. */
    if (!Array.isArray(entries)) return []
    // An entry without a string id could not be addressed by updateQueue, so it is left out.
    return entries
      .filter((entry): entry is { id: string; source?: unknown; content?: unknown } =>
        typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string')
      .map(entry => ({
        id: entry.id,
        delivery,
        source: entry.source,
        content: Array.isArray(entry.content) ? entry.content : [],
      }))
  }
  return [...prompts(inbox['next-step'], 'steer'), ...prompts(inbox['next-turn'], 'queue')]
}

/**
 * Take exactly one frame from `follow` and close the iterator. The ordinary
 * Session promotion this generator performs runs after its first yield, so
 * returning immediately keeps the read cold; the `finally` block releases the
 * observation, the listeners, and the caller's signal handler.
 * @param deps - plugin dependencies carrying the Session Controller.
 * @param address - the native durable address, validated by the controller.
 * @param signal - the operation signal.
 * @returns the header, the watermark, and the trailing window.
 */
export async function openingSnapshot(
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
    return {
      header: frame.value.header,
      cursor: frame.value.cursor,
      records: frame.value.records,
      inbox: inboxOf(frame.value.projections.values),
    }
  } finally {
    await iterator.return?.()
  }
}

/**
 * Read the log backward from the watermark until `enough` accepts the
 * contiguous suffix read so far, or the log start is reached. Each page asks for
 * twice the messages of the one before, so a target near the head costs one
 * read and a distant one a logarithmic number of them.
 * @param deps - plugin dependencies carrying the Session Controller.
 * @param address - the native durable address.
 * @param head - the watermark the read is pinned to.
 * @param signal - the operation signal.
 * @param enough - whether the suffix read so far answers the caller.
 * @returns a contiguous ascending suffix of the log ending at `head`.
 */
export async function readTail(
  deps: ControlDeps,
  address: SessionAddress,
  head: number,
  signal: AbortSignal,
  enough: (events: readonly SessionWireEvent[]) => boolean,
): Promise<SessionWireEvent[]> {
  let events: SessionWireEvent[] = []
  let before = head + 1
  let messages = TAIL_FIRST_PAGE_MESSAGES
  while (before > 0) {
    const page = await withinDeadline(deps.ctx.sessionController.page({
      address,
      throughSeq: head,
      beforeSeq: before,
      maxMessages: messages,
    }, signal), signal)
    const fresh = page.records.map(record => record.event).filter(event => event.seq < before)
    /* v8 ignore next -- a page below a positive cursor always returns at least the event before it. */
    if (fresh.length === 0) break
    events = [...fresh, ...events]
    before = fresh[0]?.seq ?? 0
    if (enough(events) || !page.hasMore) break
    messages *= 2
  }
  return events
}
