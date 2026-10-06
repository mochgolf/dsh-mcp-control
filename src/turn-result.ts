/**
 * `turn_result`: the compact outcome of the turn that answered one accepted
 * prompt, found by the prompt's `request_id`. It replaces a client-side event
 * collector: the caller never pages the raw log, keeps no cursor, and needs no
 * second channel to the endpoint — which a sandboxed agent such as Codex
 * usually cannot open from its shell. One call waits a bounded time for the turn
 * to end and returns early when it does, or as soon as the turn is blocked on a
 * decision only a human can make.
 *
 * @module @mochgolf/dsh-mcp-control
 */

import { setTimeout as delay } from 'node:timers/promises'
import type { SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
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
} from './log.ts'
import {
  boundedInputSchema,
  failureResult,
  jsonBytes,
  largestFittingPrefix,
  okResult,
  okWithinBudget,
  operationDeadline,
  type ControlDeps,
} from './result.ts'
import {
  agentStateOf,
  boundedApprovals,
  clip,
  MAX_REASON_CHARS,
  pendingApprovals,
  queueOf,
  rpcIdOf,
  textOf,
  turnFacts,
  type AgentState,
} from './status.ts'

/** Default bounded wait for one call, below a typical MCP client tool timeout. */
const DEFAULT_WAIT_MS = 20_000

/** Upper bound on the time reserved for answering once the wait ends. */
const MAX_ANSWER_MARGIN_MS = 2_000

/** A queued prompt on an idle Agent is stranded unless the Agent wakes this soon. */
const STRANDED_GRACE_MS = 250

/** Delay that batches the burst of events one step appends into one re-read. */
const COALESCE_MS = 20

/** Tool failures one result reports before counting the rest. */
const MAX_DIAGNOSTICS = 20

/** Where the prompt identified by `request_id` stands. */
export type TurnState = 'ended' | 'running' | 'queued' | 'blocked_on_approval' | 'discarded' | 'not_found'

/** One tool failure recorded in the target turn. */
interface Diagnostic {
  readonly seq: number
  readonly error: { readonly name: string; readonly code: string; readonly reason?: string }
}

/** One evaluation of the target prompt against the log and the durable inbox. */
interface Evaluation {
  readonly value: Record<string, unknown>
  readonly state: TurnState
  readonly agentStatus: AgentState
}

/** Where the target prompt sits in a log suffix: its message index and its turn's start index. */
function locate(events: readonly SessionWireEvent[], requestId: string): { message: number; start: number } | undefined {
  const message = events.findLastIndex(event =>
    event.type === 'user/message' && rpcIdOf((event.data as { source?: unknown }).source) === requestId)
  if (message === -1) return undefined
  const start = events.findLastIndex((event, index) => index < message && event.type === 'turn/start')
  return { message, start }
}

/** What became of a prompt the log never recorded entering a turn. */
type InboxFate =
  | { readonly kind: 'never' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'claimed'; readonly seq: number }
  | { readonly kind: 'canceled' }

/** One durable inbox mutation as the Agent Loop records it. */
interface InboxSplice {
  readonly target: 'next-turn' | 'next-step'
  readonly start: number
  readonly removedCount?: number
  readonly inserted: readonly { readonly id?: unknown; readonly source?: unknown }[]
  readonly outcome?: string
}

/**
 * Replay the durable inbox splices to learn what became of the prompt. The
 * loop claims a prompt with a removal that carries no outcome and records its
 * `user/message` only after the step is prepared, while a removal that drops
 * a prompt unrun — `clear_queue`, a clearing cancel, an Agent shutdown — is
 * marked `outcome: "canceled"`; telling them apart keeps a prompt that is about
 * to run from being reported as discarded.
 * @param events - the complete log, from seq 0.
 * @param requestId - the prompt's client correlation id.
 * @returns the prompt's fate in the inbox.
 */
function inboxFate(events: readonly SessionWireEvent[], requestId: string): InboxFate {
  const lists: Record<InboxSplice['target'], Array<{ id?: unknown; source?: unknown }>> = { 'next-turn': [], 'next-step': [] }
  let fate: InboxFate = { kind: 'never' }
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const splice = event.data as unknown as InboxSplice
    const removed = lists[splice.target].splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
    if (removed.some(message => rpcIdOf(message.source) === requestId)) {
      fate = splice.outcome === undefined ? { kind: 'claimed', seq: event.seq } : { kind: 'canceled' }
    }
    if (splice.inserted.some(message => rpcIdOf(message.source) === requestId)) fate = { kind: 'pending' }
  }
  return fate
}

/** Whether a suffix holds the target prompt and the start of the turn it entered. */
function holdsTarget(requestId: string): (events: readonly SessionWireEvent[]) => boolean {
  return (events) => {
    const found = locate(events, requestId)
    return found !== undefined && found.start !== -1
  }
}

/** The events of one turn, from its start onward. */
function turnEvents(events: readonly SessionWireEvent[], start: number, turn: number): SessionWireEvent[] {
  return events.slice(start).filter(event => (event.data as { turn?: unknown } | null)?.turn === undefined
    || (event.data as { turn?: unknown }).turn === turn)
}

/** The last assistant text the turn produced, with the event that carries it. */
function finalMessage(events: readonly SessionWireEvent[]): { text: string; seq: number } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionWireEvent
    if (event.type !== 'assistant/message') continue
    const content = (event.data as { message?: { content?: unknown } }).message?.content
    const text = Array.isArray(content) ? textOf(content) : ''
    if (text !== '') return { text, seq: event.seq }
  }
  return undefined
}

/** The tool failures the turn recorded, oldest first. */
function diagnosticsOf(events: readonly SessionWireEvent[]): Diagnostic[] {
  const found: Diagnostic[] = []
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const error = (event.data as { error?: { name: string; code: string; reason?: string } }).error
    if (error === undefined) continue
    found.push({
      seq: event.seq,
      error: {
        name: error.name,
        code: error.code,
        ...(error.reason === undefined ? {} : { reason: clip(error.reason, MAX_REASON_CHARS) }),
      },
    })
  }
  return found
}

/**
 * Read where the prompt identified by `request_id` stands right now.
 * @param deps - plugin dependencies.
 * @param address - the addressed Session.
 * @param requestId - the prompt's client correlation id.
 * @param signal - the operation signal.
 * @returns the evaluation and the result value it produces.
 */
async function evaluate(deps: ControlDeps, address: Address, requestId: string, signal: AbortSignal): Promise<Evaluation> {
  const agentStatus = agentStateOf(deps, address)
  const native = nativeAddress(address)
  const snapshot = await openingSnapshot(deps, native, signal)
  // The durable inbox shares the log's watermark, so a prompt is either still
  // queued or already in the log at this cut, and one queued for an Agent that
  // is not loaded is still found.
  const queued = queueOf(deps, address, snapshot).some(entry => entry.request_id === requestId)
  const base = {
    ...addressCorrelation(address),
    request_id: requestId,
    agent_status: agentStatus,
    head_seq: snapshot.cursor,
  }
  // A prompt still in the inbox has not entered the log, so the log is not
  // searched for it; the event that records its claim wakes the next read.
  if (queued) return { state: 'queued', agentStatus, value: { ...base, state: 'queued', diagnostics: [] } }
  const events = await readTail(deps, native, snapshot.cursor, signal, holdsTarget(requestId))
  const found = locate(events, requestId)
  if (found === undefined) {
    // Without the target the tail read reached the log start, so the replay sees every splice.
    const fate = inboxFate(events, requestId)
    if (fate.kind === 'claimed') {
      // Claimed for a turn whose user/message is not recorded yet: the loop
      // opens the turn before it claims, so the latest turn/start names it.
      const start = events.findLastIndex(event => event.type === 'turn/start' && event.seq < fate.seq)
      /* v8 ignore next 3 -- the loop always opens a turn before it claims queued input. */
      if (start === -1) {
        return { state: 'running', agentStatus, value: { ...base, state: 'running', diagnostics: [] } }
      }
      const turn = ((events[start] as SessionWireEvent).data as { turn: number }).turn
      const facts = turnFacts(events, start, turn)
      // A turn closed before it recorded the prompt — interrupted by a crash,
      // say — ran nothing for it.
      const state: TurnState = facts.open ? 'running' : 'ended'
      return {
        state,
        agentStatus,
        value: {
          ...base,
          state,
          turn,
          ...(facts.open ? {} : { reason: facts.reason, final_message: null }),
          diagnostics: [],
        },
      }
    }
    const state: TurnState = fate.kind === 'canceled' ? 'discarded' : fate.kind === 'pending' ? 'queued' : 'not_found'
    return { state, agentStatus, value: { ...base, state, diagnostics: [] } }
  }
  /* v8 ignore next 4 -- the loop always opens a turn before it records the prompt entering it. */
  if (found.start === -1) {
    const state: TurnState = 'running'
    return { state, agentStatus, value: { ...base, state, diagnostics: [] } }
  }
  const turn = ((events[found.start] as SessionWireEvent).data as { turn: number }).turn
  const facts = turnFacts(events, found.start, turn)
  const inTurn = turnEvents(events, found.start, turn)
  const diagnostics = diagnosticsOf(inTurn)
  const reported = {
    diagnostics: diagnostics.slice(-MAX_DIAGNOSTICS),
    ...(diagnostics.length > MAX_DIAGNOSTICS ? { diagnostics_omitted: diagnostics.length - MAX_DIAGNOSTICS } : {}),
  }
  if (!facts.open) {
    const final = finalMessage(inTurn)
    const state: TurnState = 'ended'
    return {
      state,
      agentStatus,
      value: {
        ...base,
        state,
        turn,
        reason: facts.reason,
        final_message: final?.text ?? null,
        ...(final === undefined ? {} : { final_message_seq: final.seq }),
        ...reported,
      },
    }
  }
  const approvals = pendingApprovals(events, facts.start_seq)
  const state: TurnState = approvals.length > 0 ? 'blocked_on_approval' : 'running'
  return {
    state,
    agentStatus,
    value: {
      ...base,
      state,
      turn,
      ...(approvals.length > 0 ? boundedApprovals(approvals) : {}),
      ...reported,
    },
  }
}

/**
 * Fit one result into the budget, shortening the final message when it alone
 * is too large; the caller can read the complete text through `events_read` at
 * `final_message_seq`.
 * @param deps - plugin dependencies carrying the result budget.
 * @param value - the result value.
 * @returns the result to return.
 */
function fitted(deps: ControlDeps, value: Record<string, unknown>): ReturnType<typeof okResult> {
  const budget = deps.config.maxToolResultBytes
  const text = value.final_message
  if (typeof text !== 'string' || jsonBytes(okResult(value)) <= budget) return okWithinBudget(deps, value)
  const points = Array.from(text)
  const shortened = (count: number): Record<string, unknown> => ({
    ...value,
    final_message: points.slice(0, count).join(''),
    final_message_truncated: true,
  })
  const length = largestFittingPrefix(points.length, budget, count => jsonBytes(okResult(shortened(count))))
  return okWithinBudget(deps, shortened(length))
}

/** Change notifications for one Session: its durable events and its Agent's status transitions. */
interface SessionWatch extends Disposable {
  /** Forget the changes seen so far. */
  reset(): void
  /** Resolve once a change arrives after the last reset, `ms` elapses, or `signal` aborts. */
  changed(ms: number, signal: AbortSignal): Promise<void>
}

/** Watch one Session for anything that can move its turn forward. */
function watchSession(deps: ControlDeps, sessionId: SessionId): SessionWatch {
  let dirty = false
  let wake: (() => void) | undefined
  const notify = (): void => {
    dirty = true
    const resume = wake
    wake = undefined
    resume?.()
  }
  const disposers = [
    deps.ctx.on('session/event', (session) => { if (session.id === sessionId) notify() }, { global: true }),
    deps.ctx.on('agent/status', ({ agent }) => { if (agent.id === sessionId) notify() }, { global: true }),
  ]
  return {
    reset() { dirty = false },
    async changed(ms, signal) {
      if (dirty || signal.aborted) return
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          signal.removeEventListener('abort', done)
          wake = undefined
          resolve()
        }
        const timer = setTimeout(done, ms)
        signal.addEventListener('abort', done, { once: true })
        wake = done
      })
    },
    [Symbol.dispose]() {
      for (const dispose of disposers) dispose()
    },
  }
}

/** Whether waiting longer can change the answer. */
function settled(evaluation: Evaluation): boolean {
  return evaluation.state === 'ended'
    || evaluation.state === 'discarded'
    || evaluation.state === 'not_found'
    || evaluation.state === 'blocked_on_approval'
    || evaluation.agentStatus === 'not_loaded'
}

const diagnosticSchema = z.object({
  seq: z.number(),
  error: z.object({ name: z.string(), code: z.string(), reason: z.string().optional() }),
})

/** Output contract of `turn_result`. */
const turnResultOutputSchema = z.object({
  session_id: z.string().optional(),
  parent_session_id: z.string().optional(),
  child_session_id: z.string().optional(),
  request_id: z.string(),
  state: z.enum(['ended', 'running', 'queued', 'blocked_on_approval', 'discarded', 'not_found']),
  agent_status: z.enum(['idle', 'running', 'not_loaded']),
  head_seq: z.number(),
  turn: z.number().optional(),
  reason: z.record(z.string(), z.unknown()).optional(),
  final_message: z.string().nullable().optional(),
  final_message_seq: z.number().optional(),
  final_message_truncated: z.literal(true).optional(),
  diagnostics: z.array(diagnosticSchema),
  diagnostics_omitted: z.number().optional(),
  pending_approvals: z.array(z.object({
    id: z.string(),
    seq: z.number(),
    tool_name: z.string(),
    reason: z.string().optional(),
  })).optional(),
  pending_approvals_omitted: z.number().optional(),
})

/**
 * Register `turn_result`.
 * @param server - the request-scoped MCP server.
 * @param deps - plugin dependencies carrying the Session Controller, Agent registry, and limits.
 */
export function registerTurnResult(server: McpServer, deps: ControlDeps): void {
  server.registerTool(
    'turn_result',
    {
      title: 'Get the result of a DSH turn',
      description:
        'Report the outcome of the turn that answered one accepted prompt, identified by the request_id that session_start, session_send, or child_send returned. '
        + 'state "ended" carries the turn-end reason (kind "completed", "aborted", "error", "interrupted", ...), the final assistant text, and compact tool failures; '
        + '"running" means the turn is still computing; "queued" means the prompt waits in the inbox — on an idle agent it will not start until another prompt wakes it; '
        + '"blocked_on_approval" means a human must decide in the DSH Web UI; "discarded" means the prompt entered the inbox but was removed before any turn ran it '
        + '(session_cancel with clear_queue, or the agent shut down); "not_found" means the log never recorded that request_id. '
        + 'Each call waits up to wait_ms (default 20000, capped below the endpoint request timeout) and returns as soon as the turn ends or blocks, so call it again while the state is "running". '
        + 'Raw reasoning and tool traces are never returned; use events_read for the full log.',
      inputSchema: boundedInputSchema(deps, 'turn_result', z.strictObject({
        address: addressSchema,
        request_id: z.string().min(1).max(256),
        wait_ms: z.number().int().min(0).max(2_147_483_647).default(DEFAULT_WAIT_MS)
          .describe('Longest time this call waits for the turn to end; 0 answers immediately.'),
      })),
      outputSchema: turnResultOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args, context) => {
      using guard = operationDeadline(deps, context)
      const timeout = deps.config.requestTimeoutMs
      // The wait ends early enough to answer inside the call's own deadline.
      const waitMs = Math.min(args.wait_ms, Math.max(0, timeout - Math.min(MAX_ANSWER_MARGIN_MS, Math.floor(timeout / 5))))
      const until = Date.now() + waitMs
      const correlation = { ...addressCorrelation(args.address), request_id: args.request_id }
      using watch = watchSession(deps, addressedSessionId(args.address))
      try {
        for (;;) {
          watch.reset()
          const evaluation = await evaluate(deps, args.address, args.request_id, guard.signal)
          const remaining = until - Date.now()
          if (settled(evaluation) || remaining <= 0) return fitted(deps, evaluation.value)
          const stranded = evaluation.state === 'queued' && evaluation.agentStatus === 'idle'
          await watch.changed(stranded ? Math.min(remaining, STRANDED_GRACE_MS) : remaining, guard.signal)
          guard.signal.throwIfAborted()
          if (stranded && Date.now() < until && agentStateOf(deps, args.address) === 'idle') {
            // Nothing woke the Agent: the prompt stays queued until another prompt does.
            return fitted(deps, (await evaluate(deps, args.address, args.request_id, guard.signal)).value)
          }
          await delay(COALESCE_MS, undefined, { signal: guard.signal })
        }
      } catch (error: unknown) {
        return failureResult(deps, error, guard.signal, correlation)
      }
    },
  )
}
