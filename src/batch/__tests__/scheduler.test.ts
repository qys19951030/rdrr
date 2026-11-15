import { describe, expect, it } from "vitest"
import { createScheduler } from "../scheduler"
import { MAX_CONCURRENCY } from "../types"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe("createScheduler", () => {
  it("never runs more tasks in flight than the concurrency limit", async () => {
    const limit = 2
    const scheduler = createScheduler(limit)
    let active = 0
    let maxActive = 0

    const tasks = Array.from({ length: 8 }, (_, i) =>
      scheduler.schedule({
        site: `site-${i % 3}`,
        run: async () => {
          active++
          maxActive = Math.max(maxActive, active)
          await sleep(10)
          active--
          return i
        },
      }),
    )

    const results = await Promise.all(tasks)
    expect(maxActive).toBe(limit)
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it("clamps concurrency to the hard cap and to at least 1", () => {
    expect(createScheduler(999).limit).toBe(MAX_CONCURRENCY)
    expect(createScheduler(0).limit).toBe(1)
    expect(createScheduler(Number.NaN).limit).toBe(1)
  })

  it("serializes tasks sharing a site while parallelizing different sites", async () => {
    const scheduler = createScheduler(4)
    const running = new Set<string>()
    const violations: string[] = []
    const sameSiteOrder: number[] = []

    const make = (site: string, id: number, delay: number) =>
      scheduler.schedule({
        site,
        run: async () => {
          if (running.has(site)) violations.push(site)
          running.add(site)
          if (site === "slow") sameSiteOrder.push(id)
          await sleep(delay)
          running.delete(site)
          return id
        },
      })

    await Promise.all([
      make("slow", 1, 30),
      make("other", 2, 5),
      make("other", 3, 5),
      make("slow", 4, 10),
      make("slow", 5, 10),
    ])

    expect(violations).toEqual([])
    expect(sameSiteOrder).toEqual([1, 4, 5])
  })

  it("a slow site does not block other sites from completing", async () => {
    const scheduler = createScheduler(2)
    const finished: string[] = []

    await Promise.all([
      scheduler.schedule({ site: "slow", run: async () => sleep(40).then(() => finished.push("slow-1")) }),
      scheduler.schedule({ site: "fast", run: async () => sleep(5).then(() => finished.push("fast-1")) }),
      scheduler.schedule({ site: "fast", run: async () => sleep(5).then(() => finished.push("fast-2")) }),
    ])

    expect(finished.slice(0, 2)).toEqual(["fast-1", "fast-2"])
    expect(finished).toContain("slow-1")
  })

  it("keeps the site chain alive after a task rejects", async () => {
    const scheduler = createScheduler(2)
    const result = await scheduler.schedule({ site: "flaky", run: async () => Promise.reject(new Error("boom")) }).then(
      () => "unexpected",
      () => "rejected",
    )
    const after = await scheduler.schedule({ site: "flaky", run: async () => "recovered" })

    expect(result).toBe("rejected")
    expect(after).toBe("recovered")
  })

  it("stops dequeuing once the abort signal fires", async () => {
    const controller = new AbortController()
    const scheduler = createScheduler(1, controller.signal)
    const ran: number[] = []

    const tasks = Array.from({ length: 4 }, (_, i) =>
      scheduler
        .schedule({
          site: `s${i}`,
          run: async () => {
            ran.push(i)
            await sleep(20)
            return i
          },
        })
        .catch(() => -1),
    )

    await sleep(5)
    controller.abort(new Error("stop"))
    const outcomes = await Promise.all(tasks)

    // The first task was already running and finishes; queued tasks reject.
    expect(ran).toEqual([0])
    expect(outcomes).toContain(-1)
  })
})
