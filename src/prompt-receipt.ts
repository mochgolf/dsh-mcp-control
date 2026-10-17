/** Recover prompt admission even between inbox claim and user/message emission. */
import { rpcIdOf } from './status.ts'

/** Read only this Session's own events, excluding any fork-inherited prefix. */
export function acceptedPromptId(events: readonly { type: string; data: unknown }[], requestId: string): string | undefined {
  for (const event of events) {
    const data = event.data as { id?: unknown; source?: unknown; inserted?: readonly { id?: unknown; source?: unknown }[] }
    const messages = event.type === 'user/message' ? [data]
      : event.type === 'agent/inbox/spliced' ? data.inserted ?? [] : []
    for (const message of messages) {
      if (rpcIdOf(message.source) === requestId && typeof message.id === 'string') return message.id
    }
  }
  return undefined
}
