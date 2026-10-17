/** Serialize named creation, including work that outlives an HTTP deadline. */
export async function acquireStartSlot(
  slots: Map<string, Promise<void>>, key: string, signal: AbortSignal,
): Promise<{ track<T>(work: Promise<T>): Promise<T>; [Symbol.dispose](): void }> {
  const previous = slots.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => current)
  slots.set(key, tail)
  void tail.then(() => { if (slots.get(key) === tail) slots.delete(key) })
  const held: Promise<unknown>[] = []
  const dispose = (): void => {
    void Promise.allSettled(held).then(() => {
      release()
    })
  }
  try {
    // The caller owns the deadline; a timed-out waiter releases its own queue entry.
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => { signal.removeEventListener('abort', abort); reject(signal.reason) }
      if (signal.aborted) { abort(); return }
      signal.addEventListener('abort', abort, { once: true })
      void previous.then(() => { signal.removeEventListener('abort', abort); resolve() })
    })
  } catch (error) { dispose(); throw error }
  return { track<T>(work: Promise<T>): Promise<T> { held.push(work); return work }, [Symbol.dispose]: dispose }
}
