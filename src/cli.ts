#!/usr/bin/env node

import { ensureProtocol } from "@shared"
import { Command, InvalidArgumentError } from "commander"
import { createReadStream, existsSync, writeFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"
import type { ParseResult } from "./types"
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, ManifestError, parseManifest, runBatch } from "./batch/index"
import { estimateTokens } from "./cli/budget"
import { copyToClipboard } from "./cli/clipboard"
import { parseFormat, type EnrichedResult, type OutputFormat } from "./cli/format"
import { filterHistory, readHistory, recordHistory, sanitiseArgs, sanitiseUrl } from "./cli/history"
import { enrichResult, renderOutput } from "./cli/pipeline"
import { detectUrlType } from "./detect"
import { isProbablyReaderable } from "./extract/readerable"
import { parseHtml } from "./provider/web"
import { parse } from "./rdrr"
import { readStreamText } from "./security/body"

declare const __RDRR_VERSION__: string

type InputKind = "url" | "file" | "stdin"

interface ResolvedInput {
  kind: InputKind
  /** Present for url/file; absent for stdin. */
  url?: string
  /** Present for file/stdin; absent for url. */
  html?: string
  /** Original user-provided input, for error messages. */
  raw: string
}

const looksLikeUrl = (input: string): boolean =>
  /^https?:\/\//i.test(input) || /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(input)

const resolveInput = async (input: string): Promise<ResolvedInput> => {
  if (input === "-") {
    const html = await readStreamText(process.stdin)
    return { kind: "stdin", html, raw: input }
  }

  if (!looksLikeUrl(input) && existsSync(input)) {
    const absolute = resolvePath(input)
    const html = await readStreamText(createReadStream(absolute))
    return { kind: "file", html, url: pathToFileURL(absolute).href, raw: input }
  }

  return { kind: "url", url: ensureProtocol(input), raw: input }
}

const createDebug =
  (enabled: boolean) =>
  (label: string, data?: Record<string, unknown>): void => {
    if (!enabled) return
    const payload = data ? ` ${JSON.stringify(data)}` : ""
    process.stderr.write(`[rdrr:debug] ${label}${payload}\n`)
  }

const parseLimitArg = (value: string): number => {
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("must be a positive integer")
  }
  return parsed
}

const parseOrderArg = (value: string): "newest" | "oldest" => {
  if (value !== "newest" && value !== "oldest") {
    throw new InvalidArgumentError("must be 'newest' or 'oldest'")
  }
  return value
}

const parseFormatArg = (value: string): OutputFormat => {
  try {
    return parseFormat(value)
  } catch {
    throw new InvalidArgumentError("must be one of md | json | jsonl | xml")
  }
}

const program = new Command()

program
  .name("rdrr")
  .description("Any URL, file, or HTML stream to clean markdown. 10x fewer tokens for AI agents.")
  .version(__RDRR_VERSION__)
  .argument("<input>", "URL, local .html file, or - to read HTML from stdin")
  .option("-o, --output <file>", "save to file instead of stdout")
  .option("-c, --clip", "copy output to the system clipboard (suppresses stdout)")
  .option("-j, --json", "output full JSON with metadata (alias for --format json)")
  .option("--format <fmt>", "output format: md | json | jsonl | xml", parseFormatArg)
  .option("-p, --property <name>", "extract specific field (title, author, etc.)")
  .option("-l, --language <code>", "preferred language (BCP 47)")
  .option("-n, --limit <n>", "for aggregate URLs (e.g. x.com profiles): max items to fetch", parseLimitArg)
  .option("--order <order>", "for aggregate URLs: newest|oldest", parseOrderArg, "newest")
  .option("--check", "check if URL is probably readerable (exit 0/1 without parsing)")
  .option("--llms", "append the site's /llms.txt to the output if available")
  .option(
    "--timeout <ms>",
    "timeout in milliseconds (default 25000; Reddit 120000 including rate-limit wait)",
    parseLimitArg,
  )
  .option("--user-agent <ua>", "override the outbound User-Agent header")
  .option("--github-token <token>", "GitHub API token (falls back to $GITHUB_TOKEN)")
  .option("--wpm <n>", "words-per-minute used for readTime estimation (default 200)", parseLimitArg)
  .option("--budget <tokens>", "truncate output to fit a token budget", parseLimitArg)
  .option("--quality", "include a quality/readability report (score 0-100) in JSON output")
  .option("--no-history", "skip logging this call to ~/.local/state/rdrr/history.jsonl")
  .option("--allow-private-networks", "allow fetches against RFC1918/loopback/link-local (SSRF-unsafe)")
  .option("--strict", "exit with code 3 when no content could be extracted")
  .option("--debug", "print pipeline diagnostics to stderr")
  .action(
    async (
      input: string,
      opts: {
        output?: string
        clip?: boolean
        json?: boolean
        format?: OutputFormat
        property?: string
        language?: string
        limit?: number
        order?: "newest" | "oldest"
        check?: boolean
        llms?: boolean
        timeout?: number
        userAgent?: string
        githubToken?: string
        wpm?: number
        budget?: number
        quality?: boolean
        history?: boolean
        allowPrivateNetworks?: boolean
        strict?: boolean
        debug?: boolean
      },
    ) => {
      const debug = createDebug(Boolean(opts.debug))
      const started = Date.now()

      try {
        if (opts.check) {
          if (input === "-" || (!looksLikeUrl(input) && existsSync(input))) {
            process.stderr.write("--check is only supported for URLs\n")
            process.exit(2)
          }
          const url = ensureProtocol(input)
          debug("check", { url })
          const readable =
            detectUrlType(url) !== "webpage" ||
            (await isProbablyReaderable(url, {
              allowPrivateNetworks: opts.allowPrivateNetworks,
              timeoutMs: opts.timeout,
              userAgent: opts.userAgent,
              language: opts.language,
            }))
          process.stdout.write(readable ? "readable\n" : "not readable\n")
          process.exit(readable ? 0 : 1)
        }

        const resolved = await resolveInput(input)
        debug("input", { kind: resolved.kind, url: resolved.url, bytes: resolved.html?.length })

        const result = await runPipeline(resolved, opts, debug)
        const source = resolved.url ?? resolved.raw

        debug("parsed", {
          type: result.type,
          title: result.title,
          wordCount: result.wordCount,
          contentChars: result.content.length,
        })

        const scored: EnrichedResult = enrichResult(result, opts)
        if (opts.budget) debug("budget", { budget: opts.budget, contentChars: scored.content.length })
        if (scored.quality) debug("quality", scored.quality)

        const output = formatOutput(scored, source, opts)

        const isEmptyExtraction = scored.content.trim() === ""
        if (isEmptyExtraction) {
          process.stderr.write(
            `Warning: no content extracted from ${source}. ` +
              "The source may require JavaScript, block automated access, or have no available transcript. " +
              "Try a browser-based tool or another source.\n",
          )
        }

        if (opts.output) {
          writeFileSync(opts.output, output, "utf-8")
          process.stderr.write(`Saved to ${opts.output}\n`)
        }
        if (opts.clip) {
          try {
            const backend = await copyToClipboard(output)
            process.stderr.write(`Copied ${output.length} chars to clipboard (${backend})\n`)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            process.stderr.write(`Clipboard copy failed: ${message}\n`)
            process.exit(5)
          }
        }
        if (!opts.output && !opts.clip) {
          process.stdout.write(output)
        }

        const durationMs = Date.now() - started
        if (resolved.kind === "url" && opts.history !== false) {
          const cleanArgs = sanitiseArgs(process.argv.slice(2).filter((a) => a !== resolved.raw))
          recordHistory({
            ts: new Date().toISOString(),
            url: sanitiseUrl(resolved.url!),
            title: scored.title,
            tokens: estimateTokens(output),
            ...(scored.quality ? { quality: scored.quality.score } : {}),
            durationMs,
            args: cleanArgs,
            // Empty extraction is the failure mode --failures is for, even
            // though the process exits 0 without --strict.
            ...(isEmptyExtraction ? { error: "empty extraction" } : {}),
          })
        }

        debug("done", { ms: durationMs })
        if (isEmptyExtraction && opts.strict) process.exit(3)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const hint =
          error instanceof Error && error.name === "TimeoutError" ? " Increase --timeout to wait longer." : ""
        process.stderr.write(`Error: ${message}${hint}\n`)
        if (looksLikeUrl(input) && opts.history !== false && !opts.check) {
          recordHistory({
            ts: new Date().toISOString(),
            url: sanitiseUrl(ensureProtocol(input)),
            title: "",
            tokens: 0,
            durationMs: Date.now() - started,
            args: sanitiseArgs(process.argv.slice(2).filter((a) => a !== input)),
            error: message,
          })
        }
        process.exit(1)
      }
    },
  )

interface PipelineOpts {
  language?: string
  llms?: boolean
  limit?: number
  order?: "newest" | "oldest"
  timeout?: number
  userAgent?: string
  githubToken?: string
  wpm?: number
  allowPrivateNetworks?: boolean
}

const runPipeline = async (
  resolved: ResolvedInput,
  opts: PipelineOpts,
  debug: ReturnType<typeof createDebug>,
): Promise<ParseResult> => {
  if (resolved.kind === "url") {
    const url = resolved.url!
    debug("route", { urlType: detectUrlType(url) })
    return parse(url, {
      language: opts.language,
      includeLlmsTxt: opts.llms,
      limit: opts.limit,
      order: opts.order,
      timeoutMs: opts.timeout,
      userAgent: opts.userAgent,
      githubToken: opts.githubToken,
      wordsPerMinute: opts.wpm,
      allowPrivateNetworks: opts.allowPrivateNetworks,
    })
  }

  if (opts.llms) {
    process.stderr.write("Warning: --llms is ignored when parsing local HTML or stdin\n")
  }
  debug("route", { urlType: "webpage", source: resolved.kind })
  return parseHtml(resolved.html!, { url: resolved.url, language: opts.language, wordsPerMinute: opts.wpm })
}

const formatOutput = (
  result: EnrichedResult,
  source: string,
  opts: { json?: boolean; format?: OutputFormat; property?: string },
): string => {
  const format = resolveFormat(opts)
  // renderOutput only throws for unknown --property values; keep the exact
  // stderr wording the single-URL CLI always produced.
  try {
    return renderOutput(result, source, { format, property: opts.property }, new Date().toISOString())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exit(1)
  }
}

const resolveFormat = (opts: { json?: boolean; format?: OutputFormat }): OutputFormat => {
  // `-j`/`--json` and `--format` together are ambiguous. Warn so scripted
  // callers see the collision, then fall back to `--format` (explicit beats
  // legacy) — keeps modern usage predictable without breaking `-j`-only
  // scripts.
  if (opts.json && opts.format && opts.format !== "json") {
    process.stderr.write(`Warning: both --json and --format ${opts.format} given; using --format ${opts.format}\n`)
    return opts.format
  }
  if (opts.json) return "json"
  return opts.format ?? "md"
}

// commander 14 leaks parent-defined flag names into subcommand action's opts
// object (they're accessible via `optsWithGlobals()` only). We standardise on
// `optsWithGlobals()` here so subcommand flags that collide with parent flags
// (like `--json`) still work.
interface CommandSelf {
  optsWithGlobals: () => Record<string, unknown>
}

program
  .command("history")
  .description("list recent rdrr fetches")
  .option("--json", "emit raw JSONL")
  .option("--limit <n>", "max entries to show (default 20)", parseLimitArg)
  .option("--search <q>", "substring match on title/url")
  .option("--since <date>", "only entries at or after this ISO date")
  .option("--failures", "only failed fetches (entries with an error)")
  .action(function (this: CommandSelf) {
    const opts = this.optsWithGlobals() as {
      json?: boolean
      limit?: number
      search?: string
      since?: string
      failures?: boolean
    }
    const since = opts.since ? new Date(opts.since) : undefined
    if (since && Number.isNaN(since.getTime())) {
      process.stderr.write(`Invalid --since date: ${opts.since}\n`)
      process.exit(2)
    }
    const entries = filterHistory(readHistory(), {
      limit: opts.limit ?? 20,
      search: opts.search,
      since,
      failures: opts.failures,
    })
    if (entries.length === 0) {
      process.stderr.write("no history yet\n")
      return
    }
    if (opts.json) {
      for (const e of entries) process.stdout.write(JSON.stringify(e) + "\n")
      return
    }
    for (const e of entries) {
      const ts = e.ts.replace("T", " ").slice(0, 19)
      const tokens = String(e.tokens).padStart(6)
      // Failure lines keep the exact column layout of success lines so
      // scripts that parse the output by position keep working.
      const label = e.error ? `[FAIL: ${e.error}]` : e.title || "(untitled)"
      process.stdout.write(`${ts}  ${tokens}t  ${label} — ${e.url}\n`)
    }
  })

program
  .command("last")
  .description("print the most recent rdrr fetch")
  .option("-j, --json", "full last-entry JSON")
  .action(function (this: CommandSelf) {
    const opts = this.optsWithGlobals() as { json?: boolean }
    const entries = readHistory()
    const latest = entries[entries.length - 1]
    if (!latest) {
      process.stderr.write("no history yet\n")
      process.exit(1)
    }
    if (opts.json) process.stdout.write(JSON.stringify(latest, null, 2) + "\n")
    else process.stdout.write(latest.url + "\n")
  })

interface BatchCliOptions {
  outDir: string
  concurrency?: number
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
  history?: boolean
  allowPrivateNetworks?: boolean
  strict?: boolean
}

const parseConcurrencyArg = (value: string): number => {
  const parsed = parseLimitArg(value)
  if (parsed > MAX_CONCURRENCY) {
    throw new InvalidArgumentError(`must be at most ${MAX_CONCURRENCY}`)
  }
  return parsed
}

const logStderr = (message: string): void => {
  process.stderr.write(`${message}\n`)
}

program
  .command("batch <manifest>")
  .description("process a manifest of URLs (file path, or - for stdin; one URL per line, # comments allowed)")
  .requiredOption("--out-dir <dir>", "directory for per-result files, results.jsonl and progress.jsonl")
  .option(
    `--concurrency <n>`,
    `max parallel fetches across sites, 1-${MAX_CONCURRENCY} (default ${DEFAULT_CONCURRENCY})`,
    parseConcurrencyArg,
  )
  .option("--format <fmt>", "output format per entry: md | json | jsonl | xml", parseFormatArg)
  .option("-p, --property <name>", "extract specific field (title, author, etc.)")
  .option("-l, --language <code>", "preferred language (BCP 47)")
  .option("-n, --limit <n>", "for aggregate URLs: max items to fetch", parseLimitArg)
  .option("--order <order>", "for aggregate URLs: newest|oldest", parseOrderArg, "newest")
  .option("--llms", "append the site's /llms.txt to the output if available")
  .option("--timeout <ms>", "timeout in milliseconds per request (default 25000)", parseLimitArg)
  .option("--user-agent <ua>", "override the outbound User-Agent header")
  .option("--github-token <token>", "GitHub API token (falls back to $GITHUB_TOKEN)")
  .option("--wpm <n>", "words-per-minute used for readTime estimation (default 200)", parseLimitArg)
  .option("--budget <tokens>", "truncate each output to fit a token budget", parseLimitArg)
  .option("--quality", "include a quality/readability report (score 0-100) in JSON output")
  .option("--no-history", "skip logging every call to ~/.local/state/rdrr/history.jsonl")
  .option("--allow-private-networks", "allow fetches against RFC1918/loopback/link-local (SSRF-unsafe)")
  .option("--strict", "exit 3 when any entry extracts no content")
  .action(async function (this: CommandSelf, manifest: string, opts: BatchCliOptions) {
    const all = { ...opts, ...this.optsWithGlobals() } as BatchCliOptions
    try {
      const text =
        manifest === "-"
          ? await readStreamText(process.stdin)
          : await readStreamText(createReadStream(resolvePath(manifest)))
      const { entries, duplicates } = parseManifest(text)

      const controller = new AbortController()
      const stop = (): void => controller.abort(new Error("interrupted"))
      process.once("SIGINT", stop)
      process.once("SIGTERM", stop)

      const { hasEmpty, hasFailure } = await runBatch(all.outDir, entries, duplicates, {
        concurrency: all.concurrency ?? DEFAULT_CONCURRENCY,
        format: all.format,
        property: all.property,
        language: all.language,
        llms: all.llms,
        limit: all.limit,
        order: all.order,
        timeout: all.timeout,
        userAgent: all.userAgent,
        githubToken: all.githubToken,
        wpm: all.wpm,
        budget: all.budget,
        quality: all.quality,
        history: all.history !== false,
        allowPrivateNetworks: all.allowPrivateNetworks,
        signal: controller.signal,
        log: logStderr,
      })

      // Mirrors single-URL semantics: hard failures are exit 1; --strict turns
      // any empty extraction (including an all-empty batch) into exit 3.
      if (hasFailure) process.exit(1)
      if (hasEmpty && all.strict) process.exit(3)
    } catch (error) {
      if (error instanceof ManifestError) {
        process.stderr.write(`Error: ${error.message}\n`)
        process.exit(2)
      }
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`Error: ${message}\n`)
      process.exit(1)
    }
  })

program.parse()
