import { resolve as resolvePath } from "node:path"
import type { RunBatchOptions, RunBatchResult } from "./options"
import type { BatchEntry, BatchRecord, BatchStatus, BatchSummary } from "./types"
import { createScheduler } from "./scheduler"
import { openStore, reconcileProgress, recoverState, type RecoveredState } from "./store"
import { renderSummary } from "./summary"
import { processEntry } from "./worker"

/** Initial summary counters; site stats accumulate as tasks finish. */
const createSummary = (entries: BatchEntry[], duplicates: number): BatchSummary => {
  const sites: BatchSummary["sites"] = {}
  for (const entry of entries) sites[entry.site] = { tasks: 0, totalDurationMs: 0 }
  return {
    total: entries.length,
    success: 0,
    empty: 0,
    failed: 0,
    skipped: 0,
    duplicates,
    siteCount: Object.keys(sites).length,
    sites,
  }
}

/**
 * Resume rule: only a latest `success` record is considered done. Empty and
 * failed entries are returned for reprocessing, even if they have progress
 * markers — results.jsonl is the authority, progress is just a replayable index.
 */
const selectPending = (entries: BatchEntry[], state: RecoveredState, summary: BatchSummary): BatchEntry[] =>
  entries.filter((entry) => {
    if (state.records.get(entry.url)?.status === "success") {
      summary.skipped++
      return false
    }
    return true
  })

const accountFor = (record: BatchRecord, summary: BatchSummary, options: RunBatchOptions): void => {
  const stats = summary.sites[record.site]
  if (stats) {
    stats.tasks++
    stats.totalDurationMs += record.durationMs
  }
  if (record.status === "success") {
    summary.success++
    return
  }
  if (record.status === "empty") {
    summary.empty++
    options.log(`Empty: no content extracted from ${record.url}`)
    return
  }
  summary.failed++
  options.log(`Failed: ${record.url} — ${record.error ?? "unknown error"}`)
}

/**
 * Batch orchestrator. Writes always happen in the order body file → results
 * line → progress line, so an interrupted run never marks progress for
 * something missing from the results directory. Nothing is buffered: each
 * entry's record is appended and released before the next result is awaited.
 */
export const runBatch = async (
  outDir: string,
  entries: BatchEntry[],
  duplicates: number,
  options: RunBatchOptions,
): Promise<RunBatchResult> => {
  const dir = resolvePath(outDir)
  const state = await recoverState(dir)
  await reconcileProgress(dir, state)

  const summary = createSummary(entries, duplicates)
  const pending = selectPending(entries, state, summary)
  const store = openStore(dir)
  const scheduler = createScheduler<BatchStatus>(options.concurrency, options.signal)
  let hasEmpty = false
  let hasFailure = false

  const tasks = pending.map((entry) =>
    scheduler.schedule({
      site: entry.site,
      run: async () => {
        const record = await processEntry(entry, options, store)
        await store.appendResult(record)
        await store.appendProgress(record.url)
        if (record.status === "empty") hasEmpty = true
        if (record.status === "failed") hasFailure = true
        accountFor(record, summary, options)
        return record.status
      },
    }),
  )

  const settled = await Promise.allSettled(tasks)
  await store.close()
  // A rejection here means the abort signal fired while awaiting a permit.
  if (settled.some((r) => r.status === "rejected")) hasFailure = true

  options.log(renderSummary(summary))
  return { summary, hasEmpty, hasFailure }
}
