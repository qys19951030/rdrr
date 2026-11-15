import { createReadStream, createWriteStream, existsSync, mkdirSync, type WriteStream } from "node:fs"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import type { BatchRecord } from "./types"

export const RESULTS_FILE = "results.jsonl"
export const PROGRESS_FILE = "progress.jsonl"
export const FILES_DIR = "files"

/**
 * Append-only batch storage. Writes go through one write stream per file so
 * large batches never buffer the whole result set in memory, and each record
 * is a single newline-terminated JSON object: a crash mid-run leaves every
 * previously flushed line complete and independently parseable.
 */
export interface BatchStore {
  dir: string
  /** Path of the per-result body file (caller writes the rendered output). */
  outputPath: (safeName: string) => string
  /** Append a result record (results.jsonl). */
  appendResult: (record: BatchRecord) => Promise<void>
  /** Mark a URL done (progress.jsonl). Only called after appendResult resolves. */
  appendProgress: (url: string) => Promise<void>
  /** Flush and close both streams. */
  close: () => Promise<void>
}

const createAppender = (path: string): { write: (line: string) => Promise<void>; stream: WriteStream } => {
  mkdirSync(dirname(path), { recursive: true })
  const stream = createWriteStream(path, { flags: "a", encoding: "utf-8" })
  const write = (line: string): Promise<void> =>
    new Promise((resolve, reject) => {
      stream.write(line, (error?: Error | null) => (error ? reject(error) : resolve()))
    })
  return { write, stream }
}

const endStream = (stream: WriteStream): Promise<void> =>
  new Promise((resolve, reject) => {
    stream.end((error?: Error | null) => (error ? reject(error) : resolve()))
  })

export const openStore = (dir: string): BatchStore => {
  mkdirSync(join(dir, FILES_DIR), { recursive: true })
  const results = createAppender(join(dir, RESULTS_FILE))
  const progress = createAppender(join(dir, PROGRESS_FILE))

  return {
    dir,
    outputPath: (safeName) => join(dir, FILES_DIR, safeName),
    appendResult: async (record) => results.write(JSON.stringify(record) + "\n"),
    appendProgress: async (url) => progress.write(JSON.stringify({ url, done: true }) + "\n"),
    close: async () => {
      await Promise.all([endStream(results.stream), endStream(progress.stream)])
    },
  }
}

/**
 * Reconstruct batch state from an existing output dir. `results.jsonl` is the
 * authority: the file is streamed line by line (never read whole and rewritten)
 * and each URL maps to its *latest* record, since a resume re-runs empty/failed
 * entries and appends a fresh record. A malformed trailing line (process killed
 * mid-write) is skipped rather than failing recovery.
 */
export interface RecoveredState {
  /** Latest result record per normalized URL. */
  records: Map<string, BatchRecord>
  /** URLs present in progress.jsonl. */
  progress: Set<string>
}

const readJsonl = async (path: string, onLine: (line: string) => void): Promise<void> => {
  if (!existsSync(path)) return
  const rl = createInterface({ input: createReadStream(path, "utf-8"), crlfDelay: Infinity })
  for await (const line of rl) {
    if (line.trim()) onLine(line)
  }
}

export const recoverState = async (dir: string): Promise<RecoveredState> => {
  const records = new Map<string, BatchRecord>()
  await readJsonl(join(dir, RESULTS_FILE), (line) => {
    try {
      const record = JSON.parse(line) as BatchRecord
      if (typeof record.url === "string" && typeof record.status === "string") records.set(record.url, record)
    } catch {
      // Partial last line from a hard crash: ignore, earlier lines stay valid.
    }
  })

  const progress = new Set<string>()
  await readJsonl(join(dir, PROGRESS_FILE), (line) => {
    try {
      const entry = JSON.parse(line) as { url?: unknown; done?: unknown }
      if (entry.done === true && typeof entry.url === "string") progress.add(entry.url)
    } catch {
      // Same crash-tolerance as the results log.
    }
  })

  return { records, progress }
}

/**
 * Reconcile progress against the authoritative results log: every URL with a
 * result but no progress line gets one appended. Progress entries without a
 * result are simply ignored on resume (the URL will be processed again), so
 * the two logs can never disagree about what is complete.
 */
export const reconcileProgress = async (dir: string, state: RecoveredState): Promise<void> => {
  const missing: string[] = []
  for (const url of state.records.keys()) {
    if (!state.progress.has(url)) missing.push(url)
  }
  if (missing.length === 0) return
  const appender = createAppender(join(dir, PROGRESS_FILE))
  try {
    for (const url of missing) await appender.write(JSON.stringify({ url, done: true }) + "\n")
  } finally {
    await endStream(appender.stream)
  }
}
