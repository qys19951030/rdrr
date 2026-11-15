import type { AddressInfo } from "node:net"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { RunBatchOptions } from "../options"
import { parseManifest } from "../manifest"
import { runBatch } from "../run-batch"
import { PROGRESS_FILE, RESULTS_FILE } from "../store"

const ARTICLE = (title: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${"<p>Meaningful paragraph with enough words to pass extraction thresholds and be kept.</p>".repeat(
    12,
  )}</main></body></html>`

const EMPTY = '<!doctype html><html><head><title>Shell</title></head><body><div id="root"></div></body></html>'

interface Route {
  status?: number
  body?: string
  delayMs?: number
}

let server: Server
let baseUrl: string
let requests: string[] = []
const routes = new Map<string, Route>()

const handler = (req: IncomingMessage, res: ServerResponse): void => {
  const url = req.url ?? "/"
  requests.push(url)
  const route = routes.get(url)
  if (!route) {
    res.writeHead(404).end("nope")
    return
  }
  const finish = (): void => {
    res.writeHead(route.status ?? 200, { "content-type": "text/html; charset=utf-8" })
    res.end(route.body ?? "")
  }
  if (route.delayMs) setTimeout(finish, route.delayMs)
  else finish()
}

const manifestOf = (...urls: string[]): ReturnType<typeof parseManifest> => parseManifest(urls.join("\n"))

const baseOptions = (overrides?: Partial<RunBatchOptions>): RunBatchOptions => ({
  concurrency: 4,
  history: false,
  log: () => undefined,
  ...overrides,
})

beforeEach(async () => {
  requests = []
  routes.clear()
  server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe("runBatch against a local server", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rdrr-runbatch-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("writes one body file per entry plus aligned results and progress logs", async () => {
    routes.set("/a", { body: ARTICLE("A") })
    routes.set("/b", { body: ARTICLE("B") })
    const manifest = manifestOf(`${baseUrl}/a`, `${baseUrl}/b`)

    const { summary, hasEmpty, hasFailure } = await runBatch(
      dir,
      manifest.entries,
      manifest.duplicates,
      baseOptions({ allowPrivateNetworks: true }),
    )

    expect(hasEmpty).toBe(false)
    expect(hasFailure).toBe(false)
    expect(summary.success).toBe(2)
    expect(summary.siteCount).toBe(1)

    const results = readFileSync(join(dir, RESULTS_FILE), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    const progress = readFileSync(join(dir, PROGRESS_FILE), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(results).toHaveLength(2)
    expect(progress).toHaveLength(2)
    for (const r of results) {
      expect(r.outputFile).toBeTruthy()
      expect(existsSync(join(dir, r.outputFile))).toBe(true)
      expect(progress.some((p) => p.url === r.url && p.done === true)).toBe(true)
    }
  })

  it("classifies empty extraction and HTTP failure as distinct outcomes", async () => {
    routes.set("/empty", { body: EMPTY })
    // /missing has no route -> 404 -> provider throws -> failed
    const manifest = manifestOf(`${baseUrl}/empty`, `${baseUrl}/missing`)
    const logs: string[] = []

    const { summary, hasEmpty, hasFailure } = await runBatch(
      dir,
      manifest.entries,
      manifest.duplicates,
      baseOptions({ allowPrivateNetworks: true, log: (m: string) => logs.push(m) }),
    )

    expect(summary.empty).toBe(1)
    expect(summary.failed).toBe(1)
    expect(hasEmpty).toBe(true)
    expect(hasFailure).toBe(true)
    // Two distinguishable stderr classes for callers triaging runs.
    expect(logs.some((l) => l.startsWith("Empty:"))).toBe(true)
    expect(logs.some((l) => l.startsWith("Failed:"))).toBe(true)
  })

  it("enforces the concurrency cap across sites and serializes same-site tasks", async () => {
    // One server per port => each origin is a distinct site key, while all
    // stay on loopback behind --allow-private-networks.
    const ports: number[] = []
    const siteServers: Server[] = []
    const overlap = new Map<number, number>()
    const maxOverlap = new Map<number, number>()
    const active = { count: 0, max: 0 }

    for (let site = 0; site < 3; site++) {
      const s = createServer((_req, res) => {
        const port = (s.address() as AddressInfo).port
        overlap.set(port, (overlap.get(port) ?? 0) + 1)
        maxOverlap.set(port, Math.max(maxOverlap.get(port) ?? 0, overlap.get(port) ?? 0))
        active.count++
        active.max = Math.max(active.max, active.count)
        setTimeout(() => {
          overlap.set(port, (overlap.get(port) ?? 1) - 1)
          active.count--
          res.writeHead(200, { "content-type": "text/html" }).end(ARTICLE(`P${port}`))
        }, 25)
      })
      await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve))
      const port = (s.address() as AddressInfo).port
      ports.push(port)
      siteServers.push(s)
    }

    try {
      const [p1, p2, p3] = ports
      const urls = [
        `http://127.0.0.1:${p1}/1`,
        `http://127.0.0.1:${p2}/2`,
        `http://127.0.0.1:${p1}/3`,
        `http://127.0.0.1:${p3}/4`,
        `http://127.0.0.1:${p2}/5`,
      ]
      const manifest = manifestOf(...urls)
      const { summary } = await runBatch(
        dir,
        manifest.entries,
        manifest.duplicates,
        baseOptions({ concurrency: 2, allowPrivateNetworks: true }),
      )

      expect(summary.success).toBe(5)
      expect(active.max).toBeLessThanOrEqual(2)
      // No site ever handled two requests at the same time.
      expect(Math.max(...maxOverlap.values())).toBe(1)
    } finally {
      await Promise.all(siteServers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
    }
  })

  it("resumes: skips prior successes, reprocesses empty and failed entries", async () => {
    routes.set("/ok", { body: ARTICLE("OK") })
    routes.set("/empty", { body: EMPTY })
    const manifest = manifestOf(`${baseUrl}/ok`, `${baseUrl}/empty`, `${baseUrl}/missing`)

    const first = await runBatch(
      dir,
      manifest.entries,
      manifest.duplicates,
      baseOptions({ allowPrivateNetworks: true }),
    )
    expect(first.summary.success).toBe(1)
    expect(first.summary.empty).toBe(1)
    expect(first.summary.failed).toBe(1)

    // Now make the previously empty page good and the previously missing one exist.
    routes.set("/empty", { body: ARTICLE("Now has content") })
    routes.set("/missing", { body: ARTICLE("Recovered") })

    const second = await runBatch(
      dir,
      manifest.entries,
      manifest.duplicates,
      baseOptions({ allowPrivateNetworks: true }),
    )

    expect(second.summary.skipped).toBe(1)
    expect(second.summary.success).toBe(2)
    expect(second.summary.failed).toBe(0)
    expect(second.summary.empty).toBe(0)
    // The already-successful URL was never re-requested.
    expect(requests.filter((u) => u === "/ok")).toHaveLength(1)
  })

  it("counts a budget-truncated success as completed and does not refetch it", async () => {
    routes.set("/long", { body: ARTICLE("Long") })
    const manifest = manifestOf(`${baseUrl}/long`)

    const first = await runBatch(
      dir,
      manifest.entries,
      manifest.duplicates,
      baseOptions({ allowPrivateNetworks: true, budget: 5, format: "json" }),
    )
    expect(first.summary.success).toBe(1)

    const second = await runBatch(
      dir,
      manifest.entries,
      manifest.duplicates,
      baseOptions({ allowPrivateNetworks: true, budget: 5, format: "json" }),
    )
    expect(second.summary.skipped).toBe(1)
    expect(second.summary.success).toBe(0)
    expect(requests.filter((u) => u === "/long")).toHaveLength(1)
  })

  it("applies format and language options to every entry's body file", async () => {
    routes.set("/a", { body: ARTICLE("A") })
    const manifest = manifestOf(`${baseUrl}/a`)

    await runBatch(
      dir,
      manifest.entries,
      manifest.duplicates,
      baseOptions({ allowPrivateNetworks: true, format: "json", language: "fr" }),
    )

    const results = readFileSync(join(dir, RESULTS_FILE), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    const body = JSON.parse(readFileSync(join(dir, results[0].outputFile), "utf-8"))
    expect(body.title).toBe("A")
    expect(results[0].outputFile.endsWith(".json")).toBe(true)
  })

  it("rebuilds progress from results when the two logs disagree", async () => {
    routes.set("/a", { body: ARTICLE("A") })
    routes.set("/b", { body: ARTICLE("B") })
    const manifest = manifestOf(`${baseUrl}/a`, `${baseUrl}/b`)
    await runBatch(dir, manifest.entries, manifest.duplicates, baseOptions({ allowPrivateNetworks: true }))

    // Delete progress entirely: results remain the authority and get replayed.
    rmSync(join(dir, PROGRESS_FILE))
    const second = await runBatch(
      dir,
      manifest.entries,
      manifest.duplicates,
      baseOptions({ allowPrivateNetworks: true }),
    )

    expect(second.summary.skipped).toBe(2)
    const progress = readFileSync(join(dir, PROGRESS_FILE), "utf-8").trim().split("\n")
    expect(progress).toHaveLength(2)
    expect(requests.filter((u) => u === "/a")).toHaveLength(1)
  })

  it("never writes history when history is disabled", async () => {
    // RDRR_NO_HISTORY is the env kill-switch the history module honors.
    process.env["RDRR_NO_HISTORY"] = "1"
    routes.set("/a", { body: ARTICLE("A") })
    const manifest = manifestOf(`${baseUrl}/a`)
    const result = await runBatch(
      dir,
      manifest.entries,
      manifest.duplicates,
      baseOptions({ allowPrivateNetworks: true, history: false }),
    )
    expect(result.summary.success).toBe(1)
    delete process.env["RDRR_NO_HISTORY"]
  })
})
