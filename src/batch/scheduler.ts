import { MAX_CONCURRENCY } from "./types"

/**
 * Promise-based counting semaphore. JS is single-threaded, so the
 * check-and-decrement in `acquire` is atomic relative to other acquires; the
 * microtask queue holds waiters until a release wakes the oldest one.
 */
const createSemaphore = (initial: number) => {
  let permits = initial
  const waiters: Array<() => void> = []

  const acquire = async (signal?: AbortSignal): Promise<void> => {
    if (permits > 0 && !signal?.aborted) {
      permits--
      return
    }
    await new Promise<void>((resolve, reject) => {
      const settle = (): void => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }
      const onAbort = (): void => {
        const idx = waiters.indexOf(settle)
        if (idx >= 0) waiters.splice(idx, 1)
        reject(signal?.reason ?? new Error("aborted"))
      }
      waiters.push(settle)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
    permits--
  }

  const release = (): void => {
    permits++
    const next = waiters.shift()
    if (next) next()
  }

  return { acquire, release }
}

export interface ScheduledTask<T> {
  site: string
  run: () => Promise<T>
}

/**
 * Run tasks with two constraints:
 *   1. at most `concurrency` tasks in flight at once (clamped to MAX_CONCURRENCY);
 *   2. tasks sharing a site key never overlap — each site gets a chained
 *      queue, so a slow site can only block its own tail, never other sites.
 *
 * An abort signal stops dequeuing new work; already-running tasks finish.
 * Tasks themselves decide whether to throw — a rejection rejects the
 * per-task promise returned by `schedule` but never breaks the chain.
 */
export const createScheduler = <T>(concurrency: number, signal?: AbortSignal) => {
  const limit = Math.min(Math.max(1, Math.floor(concurrency) || 1), MAX_CONCURRENCY)
  const semaphore = createSemaphore(limit)
  // Tail promise of each site's serial chain.
  const chains = new Map<string, Promise<unknown>>()

  const schedule = (task: ScheduledTask<T>): Promise<T> => {
    const previous = chains.get(task.site) ?? Promise.resolve()
    const current = (async () => {
      await previous
      await semaphore.acquire(signal)
      try {
        return await task.run()
      } finally {
        semaphore.release()
      }
    })()
    // The chain must survive a task rejection so the next same-site task still runs.
    chains.set(
      task.site,
      current.catch(() => undefined),
    )
    return current
  }

  return { schedule, limit }
}
