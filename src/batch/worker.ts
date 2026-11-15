import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { EnrichedResult } from "../cli/format"
import type { RunBatchOptions } from "./options"
import type { BatchEntry, BatchRecord } from "./types"
import { recordHistory, sanitiseArgs, sanitiseUrl } from "../cli/history"
import { enrichResult, estimateTokens, renderOutput } from "../cli/pipeline"
import { parse } from "../rdrr"
import { FILES_DIR, type BatchStore } from "./store"

const EXTENSIONS: Record<string, string> = {
  md: "md",
  json: "json",
  jsonl: "jsonl",
  xml: "xml",
}

/** Deterministic, collision-free per-entry filename; manifest dedup guarantees one URL = one file. */
const safeFileName = (url: string, format: string): string => {
  const digest = createHash("sha256").update(url).digest("hex").slice(0, 16)
  return `${digest}.${EXTENSIONS[format] ?? "md"}`
}

interface HistoryInput {
  url: string
  title: string
  tokens: number
  durationMs: number
  fetchedAt: string
  quality?: number
  error?: string
}

/** Same history shape as the single-URL CLI; a no-op when history is disabled. */
const writeHistory = (input: HistoryInput, options: RunBatchOptions): void => {
  if (!options.history) return
  recordHistory({
    ts: input.fetchedAt,
    url: sanitiseUrl(input.url),
    title: input.title,
    tokens: input.tokens,
    ...(input.quality ? { quality: input.quality } : {}),
    durationMs: input.durationMs,
    args: sanitiseArgs(process.argv.slice(2)),
    ...(input.error ? { error: input.error } : {}),
  })
}

const failedRecord = (entry: BatchEntry, fetchedAt: string, started: number, message: string): BatchRecord => ({
  url: entry.url,
  site: entry.site,
  status: "failed",
  durationMs: Date.now() - started,
  fetchedAt,
  error: message,
})

/** Map batch options onto the single-URL `parse` contract — one place per flag. */
const toParseOptions = (options: RunBatchOptions) => ({
  language: options.language,
  includeLlmsTxt: options.llms,
  limit: options.limit,
  order: options.order,
  timeoutMs: options.timeout,
  userAgent: options.userAgent,
  githubToken: options.githubToken,
  wordsPerMinute: options.wpm,
  allowPrivateNetworks: options.allowPrivateNetworks,
  signal: options.signal,
})

const persistSuccess = (
  entry: BatchEntry,
  enriched: EnrichedResult,
  output: string,
  isEmpty: boolean,
  started: number,
  fetchedAt: string,
  options: RunBatchOptions,
  store: BatchStore,
): BatchRecord => {
  const url = entry.url
  const fileName = safeFileName(url, options.format ?? "md")
  writeFileSync(store.outputPath(fileName), output, "utf-8")
  const record: BatchRecord = {
    url,
    site: entry.site,
    status: isEmpty ? "empty" : "success",
    durationMs: Date.now() - started,
    fetchedAt,
    outputFile: join(FILES_DIR, fileName),
  }
  writeHistory(
    {
      url,
      title: enriched.title,
      tokens: estimateTokens(output),
      durationMs: record.durationMs,
      fetchedAt,
      ...(enriched.quality ? { quality: enriched.quality.score } : {}),
      ...(isEmpty ? { error: "empty extraction" } : {}),
    },
    options,
  )
  return record
}

/**
 * Run one entry through the same pipeline as the single-URL CLI and persist
 * its body file. Never throws: a fetch/parse failure becomes a `failed` record
 * so one bad URL cannot abort the rest of the batch.
 */
export const processEntry = async (
  entry: BatchEntry,
  options: RunBatchOptions,
  store: BatchStore,
): Promise<BatchRecord> => {
  const started = Date.now()
  const fetchedAt = new Date(started).toISOString()
  try {
    const url = entry.url
    const result = await parse(url, toParseOptions(options))
    const enriched = enrichResult(result, options)
    const output = renderOutput(enriched, url, { format: options.format, property: options.property }, fetchedAt)
    const isEmpty = enriched.content.trim() === ""
    return persistSuccess(entry, enriched, output, isEmpty, started, fetchedAt, options, store)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const record = failedRecord(entry, fetchedAt, started, message)
    writeHistory(
      { url: entry.url, title: "", tokens: 0, durationMs: record.durationMs, fetchedAt, error: message },
      options,
    )
    return record
  }
}
