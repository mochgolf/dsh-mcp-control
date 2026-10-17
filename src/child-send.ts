/** Durable idempotency for MCP child prompts; native delivery still owns acceptance. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { openingSnapshot } from './log.ts'
import { withinDeadline, type ControlDeps } from './result.ts'
import { acquireStartSlot } from './start-slot.ts'
import { rpcIdOf } from './status.ts'
import { acceptedPromptId } from './prompt-receipt.ts'

// Cordis exposes context-bound service proxies, so their object identity is
// unsuitable for a cross-request lock. The root survives connections/reloads.
// A pending admission retains its slot even if the HTTP caller leaves.
const slotsByRuntime = new WeakMap<ControlDeps['ctx']['root'], Map<string, Promise<void>>>()

/** Serialize one request identity, authorize the durable address, and reuse an accepted receipt. */
export async function sendChildOnce(deps: ControlDeps, request: Parameters<ControlDeps['ctx']['subagents']['prompt']>[0], signal: AbortSignal): Promise<string> {
  const runtime = deps.ctx.subagents
  const slots = slotsByRuntime.get(deps.ctx.root) ?? new Map<string, Promise<void>>()
  slotsByRuntime.set(deps.ctx.root, slots)
  const key = JSON.stringify([request.parentSessionId, request.childSessionId, request.requestId])
  using slot = await acquireStartSlot(slots, key, signal)
  if (deps.ctx.agents.get(request.parentSessionId) === undefined) {
    throw new RemoteError('subagent/parent-unavailable', `parent session "${request.parentSessionId}" is not live`, {
      parentSessionId: request.parentSessionId,
    })
  }
  const address = { kind: 'subagent' as const, parentSessionId: request.parentSessionId,
    childSessionId: request.childSessionId, mode: 'continuable' as const }
  // Controller validation prevents another parent or a wrong-mode address from
  // recovering a receipt. This read does not resume a cold child.
  const snapshot = await openingSnapshot(deps, address, signal)
  const queued = snapshot.inbox?.find(message => rpcIdOf(message.source) === request.requestId)
  if (queued !== undefined) return queued.id
  const inspected = await withinDeadline(deps.ctx.sessionController.inspect(request.childSessionId, signal), signal)
  // Fork-inherited parent history cannot count as admission to this child.
  const prior = acceptedPromptId(inspected.events.slice(inspected.inheritedEventCount), request.requestId)
  if (prior !== undefined) return prior
  const receipt = await withinDeadline(slot.track(runtime.prompt(request, signal)), signal)
  return receipt.messageId
}
