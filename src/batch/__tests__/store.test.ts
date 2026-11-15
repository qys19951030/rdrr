import { appendFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { BatchRecord } from "../types"
import { openStore, PROGRESS_FILE, reconcileProgress, recoverState, RESULTS_FILE } from "../store"

const record = (url: string, status: BatchRecord["status"], extra?: Partial<BatchRecord>): BatchRecord => ({
  url,
  site: new URL(url).hostname,
  status,
  durationMs: 12,
  fetchedAt: "2026-11-15T00:00:00.000Z",
  ...extra,
})

describe("batch store", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rdrr-batch-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("appends result and progress lines that parse independently", async () => {
    const store = openStore(dir)
    await store.appendResult(record("https://a.example/1", "success", { outputFile: "files/a.md" }))
    await store.appendProgress("https://a.example/1")
    await store.close()

    const state = await recoverState(dir)
    expect(state.records.get("https://a.example/1")?.status).toBe("success")
    expect(state.progress.has("https://a.example/1")).toBe(true)
  })

  it("keeps the latest record per URL across resume runs", async () => {
    const store = openStore(dir)
    await store.appendResult(record("https://a.example/1", "failed", { error: "boom" }))
    await store.close()

    const second = openStore(dir)
    await second.appendResult(record("https://a.example/1", "success", { outputFile: "files/a.md" }))
    await second.close()

    const state = await recoverState(dir)
    expect(state.records.get("https://a.example/1")?.status).toBe("success")
  })

  it("rebuilds progress from results when progress is missing or behind", async () => {
    const store = openStore(dir)
    await store.appendResult(record("https://a.example/1", "success", { outputFile: "files/a.md" }))
    await store.appendResult(record("https://b.example/2", "empty", { outputFile: "files/b.md" }))
    // Only the first URL has a progress line.
    await store.appendProgress("https://a.example/1")
    await store.close()

    const state = await recoverState(dir)
    await reconcileProgress(dir, state)

    const repaired = await recoverState(dir)
    expect([...repaired.progress].sort()).toEqual(["https://a.example/1", "https://b.example/2"])
  })

  it("tolerates a partial trailing line from a hard crash", async () => {
    const store = openStore(dir)
    await store.appendResult(record("https://a.example/1", "success"))
    await store.close()
    appendFileSync(join(dir, RESULTS_FILE), '{"url":"https://broken.example",\n', "utf-8")
    appendFileSync(join(dir, PROGRESS_FILE), '{"url":"broken', "utf-8")

    const state = await recoverState(dir)
    expect(state.records.has("https://a.example/1")).toBe(true)
    expect(state.records.size).toBe(1)
    expect(state.progress.size).toBe(0)
  })

  it("starts from empty state when the output dir has no logs yet", async () => {
    const state = await recoverState(dir)
    expect(state.records.size).toBe(0)
    expect(state.progress.size).toBe(0)
    await expect(reconcileProgress(dir, state)).resolves.toBeUndefined()
  })

  it("places per-result body files under the files subdirectory", async () => {
    const store = openStore(dir)
    const path = store.outputPath("abc.md")
    expect(path.startsWith(join(dir, "files"))).toBe(true)
    expect(PROGRESS_FILE).toBe("progress.jsonl")
    expect(RESULTS_FILE).toBe("results.jsonl")
    await store.close()
  })
})
