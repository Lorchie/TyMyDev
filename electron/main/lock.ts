const chains = new Map<string, Promise<unknown>>()

/**
 * Serialises everything that touches one shared resource — a dependency store, a
 * virtual environment, a runtime download. Two branches sharing a lockfile install
 * into the same directory, and without this they corrupt each other halfway
 * through the move into the cache.
 *
 * Waiters run in the order they arrived; a failing holder never blocks the queue.
 */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()
  const result = previous.then(fn, fn)
  // Keep the chain alive but never let a rejection escape into the next waiter.
  chains.set(
    key,
    result.then(
      () => undefined,
      () => undefined
    )
  )
  return result
}
