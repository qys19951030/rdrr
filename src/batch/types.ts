/**
 * Outcome of one manifest entry.
 *
 * - `success`: content extracted (possibly shortened by `--budget`, which still
 *   counts as success and must not be re-fetched on resume).
 * - `empty`: the fetch worked but the extractor produced no content.
 * - `failed`: the fetch/parse pipeline threw.
 * - `skipped`: a prior run already recorded `success` for this URL; not written
 *   to the result log, only counted in the summary.
 */
export type BatchStatus = "success" | "empty" | "failed" | "skipped"

/**
 * One line of `results.jsonl`. Every field needed to reconstruct the run
 * without keeping anything in memory. `outputFile` is absent for `failed`
 * entries (no body was produced); `error` is present only for `failed`.
 */
export interface BatchRecord {
  url: string
  site: string
  status: Exclude<BatchStatus, "skipped">
  durationMs: number
  fetchedAt: string
  outputFile?: string
  error?: string
}

/** A URL the manifest asked us to process, after dedup. */
export interface BatchEntry {
  url: string
  site: string
}

interface SiteStats {
  tasks: number
  totalDurationMs: number
}

export interface BatchSummary {
  total: number
  success: number
  empty: number
  failed: number
  skipped: number
  duplicates: number
  siteCount: number
  sites: Record<string, SiteStats>
}

export const MAX_CONCURRENCY = 16
export const DEFAULT_CONCURRENCY = 4
