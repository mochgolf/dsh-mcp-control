/**
 * `session_status`: what a Session is doing right now, read without activating
 * it — whether its Agent is loaded and running, which prompts wait in its
 * durable inbox, and which approvals its open turn waits on. It distinguishes the states a
 * caller polling a turn cannot tell apart from the log alone: a turn still
 * computing, a prompt stranded in the inbox after a cancel, and a turn blocked
 * on a human decision in the Web UI.
 *
 * @module @mochgolf/dsh-mcp-control
 */

import type { SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  addressCorrelation,
  addressedSessionId,
  addressSchema,
  nativeAddress,
  openingSnapshot,
  readTail,
  type Address,
  type OpeningSnapshot,
  type PendingPrompt,
} from './log.ts'
import { boundedInputSchema, failureResult, okWithinBudget, operationDeadline, type ControlDeps } from './result.ts'

/** Characters of prompt text one queue entry previews. */
const PREVIEW_CHARS = 200

/** Queue entries one status result lists before reporting the rest as a count. */
const MAX_QUEUE_ENTRIES = 50

/** Pending approvals one result lists before reporting the rest as a count. */
const MAX_APPROVALS = 20

/** Characters kept from one free-text reason field. */
export const MAX_REASON_CHARS = 500

/** Live Agent state as the caller sees it; `not_loaded` means no Agent is attached to the Session. */
export type AgentState = 'idle' | 'running' | 'not_loaded'

/** One prompt waiting in a live Agent's inbox. */
export interface QueueEntry {
  readonly item_id: string
  readonly delivery: 'queue' | 'steer'
  readonly request_id: string | null
  readonly preview: string
}

/** One approval request whose decision has not been recorded. */
export interface PendingApproval {
  readonly id: string
  readonly seq: number
  readonly tool_name: string
  readonly reason?: string
}

/** The latest turn in a log suffix. */
export interface TurnFacts {
  readonly turn: number
  readonly start_seq: number
  readonly open: boolean
  readonly reason?: Record<string, unknown>
}

/** The client correlation id a message source carries, when it has one. */
export function rpcIdOf(source: unknown): string | undefined {
  const rpcId = (source as { rpcId?: unknown } | null | undefined)?.rpcId
  return typeof rpcId === 'string' ? rpcId : undefined
}

/** The longest prefix of `text` within `chars` code points. */
export function clip(text: string, chars: number): string {
  const points = Array.from(text)
  return points.length <= chars ? text : points.slice(0, chars).join('')
}

/** The text parts of one message's content, joined. */
export function textOf(content: readonly unknown[]): string {
  return content
    .filter((part): part is { type: 'text'; text: string } =>
      (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
    .map(part => part.text)
    .join('')
}

/** The Agent state of one Session. */
export function agentStateOf(deps: ControlDeps, address: Address): AgentState {
  return deps.ctx.agents.get(addressedSessionId(address))?.status ?? 'not_loaded'
}

/**
 * The prompts waiting in the addressed Session's inbox at the snapshot's
 * watermark. The durable inbox projection is read from the same observation as
 * the log, so a prompt is never counted both queued and claimed, and prompts
 * queued for an Agent that is not loaded are still reported; the live inbox is
 * the fallback only where no projection is registered.
 * @param deps - plugin dependencies carrying the Agent registry.
 * @param address - the addressed Session.
 * @param snapshot - the opening observation of that address.
 * @returns the waiting entries, steering prompts first.
 */
export function queueOf(deps: ControlDeps, address: Address, snapshot: OpeningSnapshot): QueueEntry[] {
  const entry = (prompt: PendingPrompt): QueueEntry => ({
    item_id: prompt.id,
    delivery: prompt.delivery,
    request_id: rpcIdOf(prompt.source) ?? null,
    preview: clip(textOf(prompt.content), PREVIEW_CHARS),
  })
  if (snapshot.inbox !== undefined) return snapshot.inbox.map(entry)
  /* v8 ignore next 6 -- the Agent Loop registers the inbox projection wherever an Agent can hold an inbox. */
  const inbox = deps.ctx.agents.get(addressedSessionId(address))?.inbox
  if (inbox === undefined) return []
  return [
    ...inbox.nextStep.map(message => entry({ id: message.id, delivery: 'steer', source: message.source, content: message.content })),
    ...inbox.nextTurn.map(message => entry({ id: message.id, delivery: 'queue', source: message.source, content: message.content })),
  ]
}

/**
 * The latest turn whose start lies in the suffix, and how it ended.
 * @param events - a contiguous ascending log suffix.
 * @returns the turn facts, or undefined when the suffix opens no turn.
 */
export function latestTurn(events: readonly SessionWireEvent[]): TurnFacts | undefined {
  const start = events.findLastIndex(event => event.type === 'turn/start')
  if (start === -1) return undefined
  const opened = events[start] as SessionWireEvent
  const turn = (opened.data as { turn: number }).turn
  return turnFacts(events, start, turn)
}

/**
 * How the turn opened at `start` ended within the suffix.
 * @param events - a contiguous ascending log suffix.
 * @param start - index of the turn's `turn/start` event.
 * @param turn - the turn number.
 * @returns whether the turn is still open, and its end reason when it is not.
 */
export function turnFacts(events: readonly SessionWireEvent[], start: number, turn: number): TurnFacts {
  const opened = events[start] as SessionWireEvent
  const ended = events.slice(start + 1).find(event =>
    event.type === 'turn/end' && (event.data as { turn?: unknown }).turn === turn)
  return {
    turn,
    start_seq: opened.seq,
    open: ended === undefined,
    ...(ended === undefined ? {} : { reason: (ended.data as { reason: Record<string, unknown> }).reason }),
  }
}

/**
 * Approvals asked after `fromSeq` whose decision the log does not yet record.
 * Approval requests are turn-enclosed, so a caller passes the open turn's start.
 * @param events - a contiguous ascending log suffix.
 * @param fromSeq - the first sequence that belongs to the turn.
 * @returns the undecided requests, oldest first.
 */
export function pendingApprovals(events: readonly SessionWireEvent[], fromSeq: number): PendingApproval[] {
  const decided = new Set<string>()
  for (const event of events) {
    if (event.seq >= fromSeq && event.type === 'approval/decided') decided.add(String((event.data as { id: unknown }).id))
  }
  const pending: PendingApproval[] = []
  for (const event of events) {
    if (event.seq < fromSeq || event.type !== 'approval/asked') continue
    const data = event.data as { id: unknown; toolName?: unknown; reason?: unknown }
    if (decided.has(String(data.id))) continue
    pending.push({
      id: String(data.id),
      seq: event.seq,
      tool_name: String(data.toolName),
      ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
    })
  }
  return pending
}

/**
 * Bound a list of pending approvals for one result: at most a fixed count, each
 * reason clipped, and the number left out reported rather than hidden.
 * @param approvals - the undecided approvals, oldest first.
 * @returns the result fields carrying them.
 */
export function boundedApprovals(approvals: readonly PendingApproval[]): { pending_approvals: PendingApproval[]; pending_approvals_omitted?: number } {
  return {
    pending_approvals: approvals.slice(0, MAX_APPROVALS).map(approval => ({
      ...approval,
      ...(approval.reason === undefined ? {} : { reason: clip(approval.reason, MAX_REASON_CHARS) }),
    })),
    ...(approvals.length > MAX_APPROVALS ? { pending_approvals_omitted: approvals.length - MAX_APPROVALS } : {}),
  }
}

/** Whether a suffix already contains the start of its latest turn. */
function holdsTurnStart(events: readonly SessionWireEvent[]): boolean {
  return events.some(event => event.type === 'turn/start')
}

const queueEntrySchema = z.object({
  item_id: z.string(),
  delivery: z.enum(['queue', 'steer']),
  request_id: z.string().nullable(),
  preview: z.string(),
})

const pendingApprovalSchema = z.object({
  id: z.string(),
  seq: z.number(),
  tool_name: z.string(),
  reason: z.string().optional(),
})

/** Output contract of `session_status`. */
const statusOutputSchema = z.object({
  session_id: z.string().optional(),
  parent_session_id: z.string().optional(),
  child_session_id: z.string().optional(),
  agent_status: z.enum(['idle', 'running', 'not_loaded']),
  head_seq: z.number(),
  turn: z.object({
    turn: z.number(),
    start_seq: z.number(),
    open: z.boolean(),
    reason: z.record(z.string(), z.unknown()).optional(),
  }).nullable(),
  queue: z.array(queueEntrySchema),
  queue_omitted: z.number().optional(),
  pending_approvals: z.array(pendingApprovalSchema),
  pending_approvals_omitted: z.number().optional(),
})

/**
 * Register `session_status`.
 * @param server - the request-scoped MCP server.
 * @param deps - plugin dependencies carrying the Session Controller and Agent registry.
 */
export function registerSessionStatus(server: McpServer, deps: ControlDeps): void {
  server.registerTool(
    'session_status',
    {
      title: 'Read a DSH session status',
      description:
        'Report what a root DSH session or one addressed subagent child is doing now, without activating it: agent_status ("running", "idle", or "not_loaded"), '
        + 'the latest turn and whether it is still open, the prompts waiting in the durable inbox with their request_id (also for an agent that is not loaded), and the approvals the open turn waits on. '
        + 'A non-empty pending_approvals means a human must decide in the DSH Web UI before the turn can continue. '
        + 'A queued prompt on an idle agent does not start by itself: it runs when another prompt wakes the agent, or session_cancel with clear_queue removes it.',
      inputSchema: boundedInputSchema(deps, 'session_status', z.strictObject({ address: addressSchema })),
      outputSchema: statusOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args, context) => {
      using guard = operationDeadline(deps, context)
      const address = nativeAddress(args.address)
      const correlation = addressCorrelation(args.address)
      try {
        const agentStatus = agentStateOf(deps, args.address)
        const snapshot = await openingSnapshot(deps, address, guard.signal)
        const queue = queueOf(deps, args.address, snapshot)
        const events = await readTail(deps, address, snapshot.cursor, guard.signal, holdsTurnStart)
        const turn = latestTurn(events)
        return okWithinBudget(deps, {
          ...correlation,
          agent_status: agentStatus,
          head_seq: snapshot.cursor,
          turn: turn ?? null,
          queue: queue.slice(0, MAX_QUEUE_ENTRIES),
          ...(queue.length > MAX_QUEUE_ENTRIES ? { queue_omitted: queue.length - MAX_QUEUE_ENTRIES } : {}),
          ...boundedApprovals(turn?.open === true ? pendingApprovals(events, turn.start_seq) : []),
        })
      } catch (error: unknown) {
        return failureResult(deps, error, guard.signal, correlation)
      }
    },
  )
}
