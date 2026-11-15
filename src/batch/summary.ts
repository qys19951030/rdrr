import type { BatchSummary } from "./types"

/**
 * Render the end-of-run summary. Pure function so the exact wording and
 * accounting are testable without touching the filesystem. All output goes to
 * stderr at the call site — stdout is reserved for result payloads.
 */
export const renderSummary = (summary: BatchSummary): string => {
  const lines: string[] = []
  lines.push("Batch summary:")
  lines.push(`  total: ${summary.total}`)
  lines.push(`  success: ${summary.success}`)
  lines.push(`  empty: ${summary.empty}`)
  lines.push(`  failed: ${summary.failed}`)
  lines.push(`  skipped: ${summary.skipped}`)
  lines.push(`  duplicates: ${summary.duplicates}`)
  lines.push(`  sites: ${summary.siteCount}`)
  lines.push("  per-site:")
  // Deterministic ordering: alphabetical by site key.
  for (const site of Object.keys(summary.sites).sort()) {
    const stats = summary.sites[site]
    if (!stats) continue
    const average = stats.tasks > 0 ? Math.round(stats.totalDurationMs / stats.tasks) : 0
    lines.push(`    ${site}: ${stats.tasks} task(s), avg ${average} ms`)
  }
  return lines.join("\n")
}
