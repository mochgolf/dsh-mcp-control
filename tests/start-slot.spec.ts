import { expect, it } from 'vitest'
import { acquireStartSlot } from '../src/start-slot.ts'

it('a cancelled waiter never lets another retry overtake unfinished native creation', async () => {
  const slots = new Map<string, Promise<void>>()
  const first = await acquireStartSlot(slots, 'same-session', new AbortController().signal)
  let finish!: () => void
  first.track(new Promise<void>(resolve => { finish = resolve }))
  first[Symbol.dispose]()
  const cancelled = new AbortController()
  const waiting = acquireStartSlot(slots, 'same-session', cancelled.signal)
  cancelled.abort(new Error('caller left'))
  await expect(waiting).rejects.toThrow('caller left')
  let entered = false
  const retry = acquireStartSlot(slots, 'same-session', new AbortController().signal).then(slot => { entered = true; return slot })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(entered).toBe(false)
  finish()
  const acquired = await retry
  expect(entered).toBe(true)
  acquired[Symbol.dispose]()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(slots.size).toBe(0)
})
