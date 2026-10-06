/**
 * The MCP control tools. Each maps one validated JSON argument object onto the
 * existing DSH service calls that own its effect and reports their own receipt
 * or public failure — no tool invents a task state or retries, and only
 * `turn_result` waits, for a bounded time, on a turn DSH is already running.
 * The set is fixed at registration, so tool names never collide.
 *
 * @module @mochgolf/dsh-mcp-control
 */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { registerEventsRead } from './events.ts'
import { checkCwd, gitLayoutOf, isFullyQualifiedPath, isWithin, type GitLayout, type WorktreeFacts } from './paths.ts'
import { registerSessionStatus, rpcIdOf } from './status.ts'
import { registerTurnResult } from './turn-result.ts'
import {
  boundedInputSchema,
  errorResult,
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

/** Working directory `session_start` accepts: fully qualified under the rule the Workspace Registry canonicalizes with. */
const cwdSchema = z.string().min(1)
  .refine(value => isFullyQualifiedPath(value), { message: 'must be a fully qualified absolute path' })
  .describe('The MCP client\'s actual, existing project directory. It selects DSH project context and Workspace grouping; a missing directory is refused rather than created, and a temporary directory does not make the Session read-only.')

/** Whether a message queues a later turn or targets the nearest step. */
const deliverySchema = z.enum(['queue', 'steer']).default('queue')

/** Output contract shared by both prompt tools. */
const promptReceiptSchema = z.object({
  session_id: z.string(),
  request_id: z.string(),
  accepted: z.literal(true),
})

/** A Workspace as receipts name it. */
const workspaceRefSchema = z.object({ id: z.string(), title: z.string() })

/** One advisory about the context the Session was started in; the start itself succeeded. */
const warningSchema = z.object({
  code: z.string(),
  message: z.string(),
  paths: z.array(z.string()).optional(),
})

/** `session_start` receipt with the project context DSH actually selected. */
const startReceiptSchema = promptReceiptSchema.extend({
  cwd: z.string(),
  workspace: workspaceRefSchema.nullable(),
  workspace_created: z.literal(true).optional(),
  agent_preset: z.string().nullable(),
  permission_preset: z.string(),
  git_worktree: z.object({
    root: z.string(),
    main_path: z.string().nullable(),
    branch: z.string().nullable(),
    main_workspace: workspaceRefSchema.nullable(),
  }).nullable(),
  warnings: z.array(warningSchema),
})

/** One receipt advisory. */
type Warning = z.infer<typeof warningSchema>

/** Display title for a Workspace registered for a linked worktree: its repository and branch. */
function worktreeTitle(worktree: WorktreeFacts): string {
  return `${basename(worktree.mainPath ?? worktree.root)} · ${worktree.branch ?? basename(worktree.root)}`
}

/**
 * Warn when the repository's metadata lies outside the directory a
 * workspace-write Session may modify: its file edits succeed, but git commands
 * that write the index, refs, or objects are denied. This holds for every
 * linked worktree, whose metadata lives in the main repository, and for a
 * subdirectory of an ordinary checkout.
 * @param deps - plugin dependencies carrying the permission presets.
 * @param layout - the git layout of the Session's directory.
 * @param cwd - the Session's canonical working directory.
 * @param preset - the Session's effective permission preset.
 * @returns the advisory, when one applies.
 */
function gitWriteWarning(deps: ControlDeps, layout: GitLayout | undefined, cwd: string, preset: string): Warning | undefined {
  if (layout === undefined) return undefined
  let sandbox: string | undefined
  try {
    sandbox = deps.ctx.permissionPresets.resolve(preset).sandbox
  } catch {
    // A derived "custom" state names no bundle; its sandbox is not knowable here.
    sandbox = undefined
  }
  if (sandbox !== 'workspace-write') return undefined
  const outside = layout.metadataDirs.filter(dir => !isWithin(cwd, dir))
  if (outside.length === 0) return undefined
  return {
    code: 'git-metadata-outside-cwd',
    message: 'This working tree\'s git metadata lies outside cwd, beyond what a workspace-write Session may modify: the Session can edit files, '
      + 'but git commands that write the repository (add, commit, checkout, stash) are likely to be denied. '
      + 'Let the client that owns this checkout commit, or choose a permission preset with wider write access.',
    paths: outside,
  }
}

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

/** Version tag separating derived Session identities from any other digest of the same fields. */
const DERIVED_SESSION_SCHEME = 'dsh-mcp-control/session-start/v1'

/**
 * Derive the Session identity that every retry of one start request reaches
 * again. A client that lost a receipt — its own tool timeout fired, or the
 * user interrupted the call — retries with the same arguments; deriving the
 * identity from them makes that retry adopt the Session the first attempt
 * created instead of starting a second one that runs the same prompt. The
 * prompt is part of the key so that a reused correlation id carrying a new task
 * never lands in an old Session where its prompt would be acknowledged as a
 * duplicate and dropped.
 * @param requestId - the client-minted correlation id.
 * @param canonicalCwd - the working directory after `realpath`, so spellings of one directory agree.
 * @param prompt - the prompt text exactly as received.
 * @returns a `session-` prefixed RFC 9562 version 8 UUID.
 */
export function derivedSessionId(requestId: string, canonicalCwd: string, prompt: string): SessionId {
  const digest = createHash('sha256').update(JSON.stringify([DERIVED_SESSION_SCHEME, requestId, canonicalCwd, prompt])).digest()
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x80
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return SessionId(`session-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`)
}

/** One text prompt part, the only content kind these tools submit. */
function textContent(text: string): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text }]
}

/** Register `session_start`: create or adopt a root session, then submit one prompt. */
function registerSessionStart(server: McpServer, deps: ControlDeps): void {
  const permissionPresetSchema = z.enum(deps.ctx.permissionPresets.names)
    .describe(`Native DSH permission preset applied before the first prompt. Available: ${deps.ctx.permissionPresets.names.join(', ')}.`)
  server.registerTool(
    'session_start',
    {
      title: 'Start a DSH session',
      description:
        'Create a root DSH session in the MCP client\'s actual project directory, or adopt the existing session with the supplied id, then submit one text prompt. '
        + 'cwd selects project context and Workspace grouping and must already exist as a directory; a missing or mistyped path is refused with stage "cwd" instead of being created. '
        + 'Using a temporary directory creates an ungrouped temporary context and does not enforce read-only access. '
        + 'If the directory belongs to a registered DSH workspace, attach the session there; otherwise leave it ungrouped. '
        + 'A linked git worktree (such as a Codex worktree) keeps its own directory and is never moved into its main checkout\'s workspace; '
        + 'git_worktree names that main checkout and its workspace, and warnings explain when git commits will be denied by the sandbox. '
        + 'Omit agent_preset to use the deployment\'s configured default; set it only as an intentional, known override. '
        + 'Set permission_preset to a native DSH preset such as "read-only"; it is applied before the first prompt, while cwd still names the real project. '
        + 'Returns once DSH accepts the prompt and never waits for the turn to finish. '
        + 'Pass a fresh request_id (a UUID) for every new start and reuse it unchanged when retrying: without session_id, the same request_id, cwd, and prompt always address the same Session, '
        + 'so a retry after a lost or timed-out receipt adopts the Session the first attempt created and does not submit the prompt twice. '
        + 'A failure that reports stage "create" still carries the session_id it tried to create, so a retry can adopt that id instead of creating a second session. '
        + 'A stage "permission" failure identifies a created Session whose prompt was not submitted.',
      inputSchema: boundedInputSchema(deps, 'session_start', z.strictObject({
        cwd: cwdSchema,
        prompt: messageBody,
        agent_preset: z.string().min(1).max(256).optional()
          .describe('Explicit DSH Agent preset override. Omit it to use the deployment default.'),
        permission_preset: permissionPresetSchema.optional(),
        session_id: opaqueId.optional()
          .describe('Explicit Session identity to create or adopt. Omit it to derive one from request_id, cwd, and prompt.'),
        request_id: requestIdSchema.optional()
          .describe('Client-minted idempotency key, unique per new start and reused unchanged on retry.'),
      })),
      outputSchema: startReceiptSchema,
    },
    async (args, context) => {
      const requestId = resolveRequestId(args.request_id)
      using guard = operationDeadline(deps, context)
      let sessionId: SessionId
      let resolvedCwd = args.cwd
      let workspaceReceipt: { id: string; title: string } | null = null
      let workspaceCreated = false
      let mainWorkspace: { id: string; title: string } | null = null
      const warnings: Warning[] = []
      let agentPreset: string | null = null
      let permissionPreset: string
      // Session creation makes a missing directory, so a mistyped or removed
      // path would silently start an empty project; it is refused here instead.
      let canonicalCwd: string
      try {
        const checked = await withinDeadline(checkCwd(args.cwd), guard.signal)
        if (!checked.ok) {
          return errorResult(deps, checked.code, checked.message, {
            cwd: args.cwd,
            request_id: requestId,
            stage: 'cwd',
            ...(checked.reason === undefined ? {} : { reason: checked.reason }),
          })
        }
        canonicalCwd = checked.canonical
      } catch (error: unknown) {
        return failureResult(deps, error, guard.signal, { request_id: requestId, stage: 'cwd' })
      }
      // Repository facts only inform the receipt; a layout that cannot be read omits them.
      let layout: GitLayout | undefined
      try {
        layout = await withinDeadline(gitLayoutOf(canonicalCwd).catch(() => undefined), guard.signal)
      } catch (error: unknown) {
        return failureResult(deps, error, guard.signal, { request_id: requestId, stage: 'cwd' })
      }
      const worktree = layout?.worktree
      // The identity is chosen here rather than inside the controller, because a
      // create that outlives the deadline can still finish: a session nobody can
      // name is unreachable through an interface with no enumeration. A caller's
      // request_id derives it, so a retry that never saw the receipt reaches it again.
      const attempted = args.session_id !== undefined
        ? SessionId(args.session_id)
        : args.request_id === undefined
          ? mintSessionId()
          : derivedSessionId(args.request_id, canonicalCwd, args.prompt)
      try {
        // Workspace lookup only adds UI grouping; a path the registry cannot inspect retains native cwd creation.
        let workspace = await withinDeadline(
          deps.ctx.workspaceRegistry.resolveByPath(args.cwd).catch(() => undefined),
          guard.signal,
        )
        if (worktree?.mainPath !== undefined && worktree.mainPath !== null) {
          const main = await withinDeadline(
            deps.ctx.workspaceRegistry.resolveByPath(worktree.mainPath).catch(() => undefined),
            guard.signal,
          )
          mainWorkspace = main === undefined ? null : { id: main.id, title: main.title }
        }
        // Only the worktree's own root can be its Workspace: membership requires
        // the Session's directory to equal the Workspace path exactly.
        if (workspace === undefined && deps.config.autoRegisterWorktrees && worktree?.root === canonicalCwd) {
          try {
            workspace = await withinDeadline(deps.ctx.workspaceRegistry.create(canonicalCwd, worktreeTitle(worktree)), guard.signal)
            workspaceCreated = true
          } catch (error: unknown) {
            if (guard.signal.aborted) throw error
            warnings.push({
              code: 'workspace-registration-failed',
              message: 'The worktree could not be registered as a Workspace; the Session was started ungrouped.',
            })
          }
        }
        const created = await withinDeadline(deps.ctx.sessionController.create({
          ...(workspace === undefined ? { cwd: args.cwd } : { workspaceId: workspace.id }),
          sessionId: attempted,
          ...(args.agent_preset === undefined ? {} : { agentPreset: args.agent_preset }),
        }), guard.signal)
        sessionId = created.sessionId
        resolvedCwd = workspace?.path ?? args.cwd
        workspaceReceipt = workspace === undefined ? null : { id: workspace.id, title: workspace.title }
        agentPreset = created.agentPreset ?? null
      } catch (error: unknown) {
        return failureResult(deps, error, guard.signal, {
          session_id: attempted,
          request_id: requestId,
          stage: 'create',
        })
      }
      const correlation = { session_id: sessionId, request_id: requestId }
      try {
        guard.signal.throwIfAborted()
        const session = deps.ctx.sessions.get(sessionId)!
        if (args.permission_preset !== undefined) {
          deps.ctx.permissionPresets.set(session, args.permission_preset)
        }
        permissionPreset = deps.ctx.permissionPresets.current(session)
        const gitWarning = gitWriteWarning(deps, layout, canonicalCwd, permissionPreset)
        if (gitWarning !== undefined) warnings.push(gitWarning)
      } catch (error: unknown) {
        return failureResult(deps, error, guard.signal, { ...correlation, stage: 'permission' })
      }
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
      return okWithinBudget(deps, {
        session_id: sessionId,
        request_id: requestId,
        accepted: true,
        cwd: resolvedCwd,
        workspace: workspaceReceipt,
        ...(workspaceCreated ? { workspace_created: true } : {}),
        agent_preset: agentPreset,
        permission_preset: permissionPreset,
        git_worktree: worktree === undefined
          ? null
          : { root: worktree.root, main_path: worktree.mainPath, branch: worktree.branch, main_workspace: mainWorkspace },
        warnings,
      })
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

/** Register `session_cancel`: ask the live root Agent to interrupt its current turn, optionally clearing its inbox first. */
function registerSessionCancel(server: McpServer, deps: ControlDeps): void {
  server.registerTool(
    'session_cancel',
    {
      title: 'Cancel a DSH session turn',
      description:
        'Ask the live Agent attached to a root DSH session to interrupt its current turn. Descendant subagents are left alone. '
        + 'By default unclaimed inbox prompts stay queued, and they run as soon as any later prompt wakes the agent; '
        + 'set clear_queue to remove them first, so nothing sent before the cancel runs afterwards. '
        + 'The receipt means the interrupt was admitted, not that the turn has already stopped.',
      inputSchema: boundedInputSchema(deps, 'session_cancel', z.strictObject({
        session_id: opaqueId,
        clear_queue: z.boolean().default(false)
          .describe('Remove every prompt still waiting in the inbox before interrupting the turn.'),
      })),
      outputSchema: z.object({
        session_id: z.string(),
        accepted: z.literal(true),
        removed_queue_items: z.array(z.object({ item_id: z.string(), request_id: z.string().nullable() })).optional(),
      }),
    },
    async (args, context) => {
      using guard = operationDeadline(deps, context)
      const correlation = { session_id: args.session_id }
      const sessionId = SessionId(args.session_id)
      const removed: Array<{ item_id: string; request_id: string | null }> = []
      try {
        guard.signal.throwIfAborted()
        if (args.clear_queue) {
          // Removal goes through the controller's own queue mutation, which keeps
          // its ownership checks and retires the prompt's upload bindings.
          const inbox = deps.ctx.agents.get(sessionId)?.inbox
          for (const message of inbox === undefined ? [] : [...inbox.nextStep, ...inbox.nextTurn]) {
            try {
              await withinDeadline(deps.ctx.sessionController.updateQueue({
                sessionId,
                itemId: message.id,
                action: { kind: 'remove' },
              }), guard.signal)
              removed.push({ item_id: message.id, request_id: rpcIdOf(message.source) ?? null })
            } catch (error: unknown) {
              // The Agent claimed the prompt meanwhile; the interrupt below stops it.
              if (remoteErrorOf(error)?.code !== 'session/queue-item-not-found') throw error
            }
          }
        }
        const receipt = deps.ctx.sessionController.cancel({ sessionId })
        return okWithinBudget(deps, {
          session_id: args.session_id,
          accepted: receipt.accepted,
          ...(args.clear_queue ? { removed_queue_items: removed } : {}),
        })
      } catch (error: unknown) {
        // A removal is durable even when the interrupt then fails, so the
        // caller learns exactly which prompts are already gone.
        return failureResult(deps, error, guard.signal, {
          ...correlation,
          ...(args.clear_queue ? { removed_queue_items: removed } : {}),
        })
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
        'List the catalog-reachable durable descendants of a root DSH session as native entries, each carrying its durable direct parent id and root-relative depth. '
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
 * Build one request-scoped MCP server carrying the fixed control tools.
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
  registerSessionStatus(server, deps)
  registerTurnResult(server, deps)
  return server
}
