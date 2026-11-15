import type { PerUrlOptions } from "../cli/pipeline"
import type { BatchSummary } from "./types"

export interface RunBatchOptions extends PerUrlOptions {
  concurrency: number
  /** History is written per entry unless explicitly disabled. */
  history: boolean
  signal?: AbortSignal
  /** Sink for per-entry warnings and the final summary (never stdout). */
  log: (message: string) => void
}

export interface RunBatchResult {
  summary: BatchSummary
  /** Set when at least one entry came back empty — drives --strict exit 3. */
  hasEmpty: boolean
  /** Set when at least one entry threw — drives exit 1. */
  hasFailure: boolean
}
