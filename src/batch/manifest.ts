import { ensureProtocol } from "@shared"
import type { BatchEntry } from "./types"
import { isValidUrl, normalizeUrl, resolveSiteKey } from "../detect"

export interface ParsedManifest {
  entries: BatchEntry[]
  /** Number of extra occurrences of URLs already seen earlier in the manifest. */
  duplicates: number
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ManifestError"
  }
}

/**
 * Parse a manifest's text: one address per line. Blank lines and lines whose
 * first non-whitespace character is `#` are ignored. Each surviving line must
 * be a valid http(s) URL (a missing scheme gets `https://` prepended, matching
 * single-URL CLI semantics).
 *
 * Repeated addresses are processed once; every repeat after the first is
 * counted in `duplicates`. Dedup uses the normalized form so hash-only
 * differences don't schedule the same page twice.
 */
export const parseManifest = (text: string): ParsedManifest => {
  const seen = new Set<string>()
  const entries: BatchEntry[] = []
  let duplicates = 0

  const lines = text.split(/\r?\n/)
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) continue

    const url = normalizeUrl(ensureProtocol(line))
    if (!isValidUrl(url)) {
      throw new ManifestError(`Invalid URL on line ${index + 1}: ${line}`)
    }

    if (seen.has(url)) {
      duplicates++
      continue
    }
    seen.add(url)
    entries.push({ url, site: resolveSiteKey(url) })
  }

  if (entries.length === 0) {
    throw new ManifestError("Manifest contains no usable URLs")
  }

  return { entries, duplicates }
}
