/**
 * The seven MCP tools. Each maps one validated JSON argument object onto one
 * existing DSH service call and reports that call's own receipt or its own
 * public failure — no tool waits for a model turn, invents a task state, or
 * retries. The set is fixed at registration, so tool names never collide.
 *
 * @module @mochgolf/dsh-mcp-control
 */

import { isAbsolute } from 'node:path'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { registerEventsRead } from './events.ts'
import {
  boundedInputSchema,
  failureResult,
  okWithinBudget,
  operationDeadline,
  withinDeadline,
  type ControlDeps,
} from './result.ts'

/** MCP implementation identity reported to clients; this protocol identity is not the npm version. */
const SERVER_INFO = { name: 'deepseek-harness-mcp-control', version: '0.0.1' } as const

/** One opaque durable identity accepted from a client. */
const opaqueId = z.string().min(1).max(256)

/** One human-authored message body: non-blank, delivered to DSH exactly as received. */
const messageBody = z.string()
  .max(Number.MAX_SAFE_INTEGER)
  .refine(value => value.trim().length > 0, { message: 'must contain non-whitespace text' })

/** Client-minted correlation identity, preserved verbatim on the accepted message. */
const requestIdSchema = z.string().min(1).max(256)

/** Working directory `session_start` accepts; the platform predicate is the one the Session header validates `cwd` with. */
const cwdSchema = z.string().min(1).refine(value => isAbsolute(value), { message: 'must be an absolute path' })

/** Whether a message queues a later turn or targets the nearest step. */
const deliverySchema = z.enum(['queue', 'steer']).default('queue')

/** Output contract shared by both prompt tools. */
const promptReceiptSchema = z.object({
  session_id: z.string(),
  request_id: z.string(),
  accepted: z.literal(true),
})

/** Mint the client correlation identity when the caller did not supply one. */
function resolveRequestId(supplied: string | undefined): SessionRequestId {
  return supplied === undefined
    ? brandString<SessionRequestId>(randomUUID())
    : brandString<SessionRequestId>(supplied)
}

/** Mint one durable Session identity, the way the Session Controller mints a create that arrives without one. */
function mintSessionId(): SessionId {
  return SessionId(`session-${randomUUID()}`)
}

/** One text prompt part, the only content kind these tools submit. */
function textContent(text: string): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text }]
}

/** Register `session_start`: create or adopt a root session, then submit one prompt. */
function registerSessionStart(server: McpServer, deps: ControlDeps): void {
  server.registerTool(
    'session_start',
    {
      title: 'Start a DSH session',
      description:
        'Create a root DSH session at an absolute working directory, or adopt the existing session with the supplied id, then submit one text prompt. '
        + 'Returns once DSH accepts the prompt and never waits for the turn to finish. '
        + 'Reusing the same request_id links a retry to the message the first attempt persisted. '
        + 'A failure that reports stage "create" still carries the session_id it tried to create, so a retry can adopt that id instead of creating a second session.',
      inputSchema: boundedInputSchema(deps, 'session_start', z.strictObject({
        cwd: cwdSchema,
        prompt: messageBody,
        agent_preset: z.string().min(1).max(256).optional(),
        session_id: opaqueId.optional(),
        request_id: requestIdSchema.optional(),
      })),
      outputSchema: promptReceiptSchema,
    },
    async (args, context) => {
      const requestId = resolveRequestId(args.request_id)
      using guard = operationDeadline(deps, context)
      // The identity is minted here rather than inside the controller, because a
      // create that outlives the deadline can still finish: a session nobody can
      // name is unreachable through an interface with no enumeration, and a
      // retry without the id would create a second one.
      const attempted = args.session_id === undefined ? mintSessionId() : SessionId(args.session_id)
      let sessionId: SessionId
      try {
        const created = await withinDeadline(deps.ctx.sessionController.create({
          cwd: args.cwd,
          sessionId: attempted,
          ...(args.agent_preset === undefined ? {} : { agentPreset: args.agent_preset }),
        }), guard.signal)
        sessionId = created.sessionId
      } catch (error: unknown) {
        return failureResult(deps, error, guard.signal, {
          session_id: attempted,
          request_id: requestId,
          stage: 'create',
        })
      }
      const correlation = { session_id: sessionId, request_id: requestId }
      try {
        await withinDeadline(deps.ctx.sessionController.prompt({
          requestId,
          sessionId,
          mode: 'queue',
          content: textContent(args.prompt),
        }, guard.signal), guard.signal)
      } catch (error: unknown) {
        // The session was created and is deliberately not rolled back, so the
        // caller can locate it and decide whether to resend.
        return failureResult(deps, error, guard.signal, { ...correlation, stage: 'prompt' })
      }
      return okWithinBudget(deps, { session_id: sessionId, request_id: requestId, accepted: true })
    },
  )
}

/** Register `session_send`: submit one prompt to an existing root session. */
function registerSessionSend(server: McpServer, deps: ControlDeps): void {
  server.registerTool(
    'session_send',
    {
      title: 'Send to a DSH session',
      description:
        'Submit one text prompt to an existing root DSH session. delivery "queue" (the default) adds a later turn; "steer" targets the nearest step. '
        + 'Returns the native acceptance receipt only, never a completion or a scheduling order.',
      inputSchema: boundedInputSchema(deps, 'session_send', z.strictObject({
        session_id: opaqueId,
        message: messageBody,
        delivery: deliverySchema,
        request_id: requestIdSchema.optional(),
      })),
      outputSchema: promptReceiptSchema,
    },
    async (args, context) => {
      const requestId = resolveRequestId(args.request_id)
      using guard = operationDeadline(deps, context)
      const correlation = { session_id: args.session_id, request_id: requestId }
      try {
        await withinDeadline(deps.ctx.sessionController.prompt({
          requestId,
          sessionId: SessionId(args.session_id),
          mode: args.delivery,
          content: textContent(args.message),
        }, guard.signal), guard.signal)
      } catch (error: unknown) {
        return failureResult(deps, error, guard.signal, correlation)
      }
      return okWithinBudget(deps, { session_id: args.session_id, request_id: requestId, accepted: true })
    },
  )
}

/** Register `session_cancel`: ask the live root Agent to interrupt its current turn. */
function registerSessionCancel(server: McpServer, deps: ControlDeps): void {
  server.registerTool(
    'session_cancel',
    {
      title: 'Cancel a DSH session turn',
      description:
        'Ask the live Agent attached to a root DSH session to interrupt its current turn. Unclaimed pending inbox entries and descendant subagents are left alone. '
        + 'The receipt means the interrupt was admitted, not that the turn has already stopped.',
      inputSchema: boundedInputSchema(deps, 'session_cancel', z.strictObject({ session_id: opaqueId })),
      outputSchema: z.object({ session_id: z.string(), accepted: z.literal(true) }),
    },
    (args, context) => {
      using guard = operationDeadline(deps, context)
      const correlation = { session_id: args.session_id }
      try {
        guard.signal.throwIfAborted()
        const receipt = deps.ctx.sessionController.cancel({ sessionId: SessionId(args.session_id) })
        return okWithinBudget(deps, { session_id: args.session_id, accepted: receipt.accepted })
      } catch (error: unknown) {
        return failureResult(deps, error, guard.signal, correlation)
      }
    },
  )
}

/** Register `agents_list`: the durable descendant tree of one root session. */
function registerAgentsList(server: McpServer, deps: ControlDeps): void {
  server.registerTool(
    'agents_list',
    {
      title: 'List a session subagent tree',
      description:
        'List every durable descendant of a root DSH session as native entries, each carrying its durable direct parent id and root-relative depth. '
        + 'Native diagnostic entries are relayed unchanged and never renumbered. activity "running" means the session record is resident, not that a model is computing, '
        + 'and it is never a completion state. No child is resumed, restored, or repaired by this call.',
      inputSchema: boundedInputSchema(deps, 'agents_list', z.strictObject({ root_session_id: opaqueId })),
      outputSchema: z.object({
        root_session_id: z.string(),
        entries: z.array(z.record(z.string(), z.unknown())),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args, context) => {
      using guard = operationDeadline(deps, context)
      const correlation = { root_session_id: args.root_session_id }
      let entries: readonly Record<string, unknown>[]
      try {
        entries = await withinDeadline(
          deps.ctx.subagents.listDescendants(SessionId(args.root_session_id), guard.signal),
          guard.signal,
        )
      } catch (error: unknown) {
        return failureResult(deps, error, guard.signal, correlation)
      }
      return okWithinBudget(deps, { root_session_id: args.root_session_id, entries: [...entries] })
    },
  )
}

/** Register `child_send`: deliver one prompt through the child's live direct parent. */
function registerChildSend(server: McpServer, deps: ControlDeps): void {
  server.registerTool(
    'child_send',
    {
      title: 'Send to a continuable DSH subagent',
      description:
        'Deliver one text prompt to an existing continuable DSH subagent through its live direct parent. The direct parent must be live; a cold parent is refused rather than resumed. '
        + 'Returns the inbox identity of the accepted message; later execution is independent of this call.',
      inputSchema: boundedInputSchema(deps, 'child_send', z.strictObject({
        parent_session_id: opaqueId,
        child_session_id: opaqueId,
        message: messageBody,
        delivery: deliverySchema,
        request_id: requestIdSchema.optional(),
      })),
      outputSchema: z.object({
        parent_session_id: z.string(),
        child_session_id: z.string(),
        request_id: z.string(),
        message_id: z.string(),
        accepted: z.literal(true),
      }),
    },
    async (args, context) => {
      const requestId = resolveRequestId(args.request_id)
      using guard = operationDeadline(deps, context)
      const correlation = {
        parent_session_id: args.parent_session_id,
        child_session_id: args.child_session_id,
        request_id: requestId,
      }
      let messageId: string
      try {
        const receipt = await withinDeadline(deps.ctx.subagents.prompt({
          requestId,
          parentSessionId: SessionId(args.parent_session_id),
          childSessionId: SessionId(args.child_session_id),
          mode: 'continuable',
          delivery: args.delivery,
          content: textContent(args.message),
        }, guard.signal), guard.signal)
        messageId = receipt.messageId
      } catch (error: unknown) {
        return failureResult(deps, error, guard.signal, correlation)
      }
      return okWithinBudget(deps, { ...correlation, message_id: messageId, accepted: true })
    },
  )
}

/** Register `child_interrupt`: the native parent-authorized interrupt. */
function registerChildInterrupt(server: McpServer, deps: ControlDeps): void {
  server.registerTool(
    'child_interrupt',
    {
      title: 'Interrupt a continuable DSH subagent',
      description:
        'Ask a continuable DSH subagent to stop through its durable direct parent. The native address check authorizes the parent against the live target; '
        + 'an already-finished or absent target is accepted as a no-op, so the receipt does not prove the target existed or has stopped.',
      inputSchema: boundedInputSchema(deps, 'child_interrupt', z.strictObject({
        parent_session_id: opaqueId,
        child_session_id: opaqueId,
      })),
      outputSchema: z.object({
        parent_session_id: z.string(),
        child_session_id: z.string(),
        accepted: z.literal(true),
      }),
    },
    (args, context) => {
      using guard = operationDeadline(deps, context)
      const correlation = {
        parent_session_id: args.parent_session_id,
        child_session_id: args.child_session_id,
      }
      try {
        guard.signal.throwIfAborted()
        const receipt = deps.ctx.subagents.interruptByParent(
          SessionId(args.child_session_id),
          SessionId(args.parent_session_id),
          'continuable',
        )
        return okWithinBudget(deps, { ...correlation, accepted: receipt.accepted })
      } catch (error: unknown) {
        return failureResult(deps, error, guard.signal, correlation)
      }
    },
  )
}

/**
 * Build one request-scoped MCP server carrying the fixed seven tools.
 * @param deps - plugin dependencies shared by every tool.
 * @returns a fresh server for one MCP request.
 */
export function createControlServer(deps: ControlDeps): McpServer {
  const server = new McpServer(SERVER_INFO)
  registerSessionStart(server, deps)
  registerSessionSend(server, deps)
  registerSessionCancel(server, deps)
  registerAgentsList(server, deps)
  registerChildSend(server, deps)
  registerChildInterrupt(server, deps)
  registerEventsRead(server, deps)
  return server
}
