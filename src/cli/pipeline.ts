import type { ParseResult } from "../types"
import type { EnrichedResult, OutputFormat } from "./format"
import { estimateTokens, truncateToBudget } from "./budget"
import { renderJsonl, renderXml } from "./format"
import { computeQuality } from "./quality"

/** Flags that apply identically to one URL and to every entry of a batch. */
export interface PerUrlOptions {
  format?: OutputFormat
  property?: string
  language?: string
  llms?: boolean
  limit?: number
  order?: "newest" | "oldest"
  timeout?: number
  userAgent?: string
  githubToken?: string
  wpm?: number
  budget?: number
  quality?: boolean
  allowPrivateNetworks?: boolean
}

/** Budget truncation that still counts as success — re-runs must not refetch it. */
const applyBudget = (result: EnrichedResult, budget: number): EnrichedResult => {
  const { content, info } = truncateToBudget(result.content, budget)
  if (!info) return result
  // Attach `truncated` as an extra field so JSON output carries it; frontmatter/
  // markdown modes get the inline `[truncated ...]` marker already in `content`.
  return { ...result, content, truncated: info }
}

/**
 * Apply the post-parse stages shared by the single-URL CLI and batch mode, in
 * the exact order the CLI always used them: empty marker, budget, quality.
 */
export const enrichResult = (result: ParseResult, opts: PerUrlOptions): EnrichedResult => {
  const extracted: EnrichedResult = result.content.trim() ? result : { ...result, extractionEmpty: true }
  const budgeted = opts.budget ? applyBudget(extracted, opts.budget) : extracted
  return opts.quality ? { ...budgeted, quality: computeQuality(budgeted) } : budgeted
}

const pickProperty = (result: ParseResult, property: string): unknown => {
  // Route through a record index instead of a blanket cast so future
  // ParseResult additions surface via the type system.
  const record: Record<string, unknown> = { ...result }
  return Object.hasOwn(record, property) ? record[property] : undefined
}

const yamlString = (value: string): string => JSON.stringify(value.replace(/\n/g, " "))

const buildFrontmatter = (result: ParseResult, source: string): string => {
  const fields: Array<[string, unknown]> = [
    ["title", result.title],
    ["author", result.author],
    ["site", result.siteName],
    ["published", result.published],
    ["source", source],
    ["next_page", result.nextPageUrl],
    ["domain", result.domain],
    ["language", result.language],
    ["dir", result.dir],
    ["description", result.description],
    ["word_count", result.wordCount],
    // Explicit signal for agents: a frontmatter-only document is a failed
    // extraction, not a page with no content.
    ["extraction", result.content.trim() === "" ? "empty" : undefined],
  ]

  const lines = fields
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${typeof value === "string" ? yamlString(value) : value}`)

  return lines.length > 0 ? `---\n${lines.join("\n")}\n---\n\n` : ""
}

/**
 * Render an enriched result exactly like the single-URL CLI would. `property`
 * failure is signalled by a thrown error carrying the same wording so both
 * entry points report it identically.
 */
export const renderOutput = (
  result: EnrichedResult,
  source: string,
  opts: Pick<PerUrlOptions, "format" | "property">,
  fetchedAt: string,
): string => {
  if (opts.property) {
    const value = pickProperty(result, opts.property)
    if (value === undefined) throw new Error(`Property "${opts.property}" not found`)
    return typeof value === "string" ? value : JSON.stringify(value, null, 2)
  }

  switch (opts.format ?? "md") {
    case "json":
      return JSON.stringify(result, null, 2)
    case "jsonl":
      return renderJsonl(result)
    case "xml":
      return renderXml(result, { source, fetchedAt })
    case "md":
    default:
      return buildFrontmatter(result, source) + result.content
  }
}

export { estimateTokens }
