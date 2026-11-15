import type { AddressInfo } from "node:net"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const CLI = resolve(__dirname, "../../dist/cli.mjs")

const run = (args: string[], stdin?: string): { status: number | null; stdout: string; stderr: string } => {
  const res = spawnSync("node", [CLI, ...args], {
    input: stdin,
    encoding: "utf-8",
    env: { ...process.env, RDRR_NO_HISTORY: "1" },
    timeout: 30_000,
  })
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}

const ARTICLE_HTML = `<!doctype html><html><head><title>CLI Test Article</title></head><body><main><h1>CLI Test Article</h1>${"<p>Meaningful paragraph with enough words to pass extraction thresholds and be kept.</p>".repeat(12)}</main></body></html>`

const EMPTY_HTML = '<!doctype html><html><head><title>Shell</title></head><body><div id="root"></div></body></html>'

// These tests exercise the built CLI binary; they are skipped when dist/ has
// not been built yet (run `pnpm build` first).
describe.skipIf(!existsSync(CLI))("cli (built dist)", () => {
  it("rejects oversized stdin instead of parsing a partial document", () => {
    const { status, stdout, stderr } = run(["-"], "x".repeat(20 * 1024 * 1024 + 1))
    expect(status).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toContain("20971520-byte limit")
  })

  it("recognizes npm URLs in --check without fetching the bot-walled website", () => {
    const { status, stdout } = run(["https://www.npmjs.com/package/rdrr", "--check"])
    expect(status).toBe(0)
    expect(stdout.trim()).toBe("readable")
  })
  it.each(["10junk", "1.5", "2e3", "9007199254740993"])("rejects invalid integer arguments: %s", (value) => {
    const { status, stderr } = run(["-", "--budget", value], ARTICLE_HTML)
    expect(status).not.toBe(0)
    expect(stderr).toContain("positive integer")
  })
  it("parses HTML from stdin and prints frontmatter + markdown, exit 0", () => {
    const { status, stdout } = run(["-"], ARTICLE_HTML)
    expect(status).toBe(0)
    expect(stdout).toContain("---")
    expect(stdout).toContain('title: "CLI Test Article"')
    expect(stdout).toContain("Meaningful paragraph")
    expect(stdout).not.toContain("extraction:")
  })

  it("marks empty extraction in frontmatter, warns on stderr, exit 0", () => {
    const { status, stdout, stderr } = run(["-"], EMPTY_HTML)
    expect(status).toBe(0)
    expect(stdout).toContain('extraction: "empty"')
    expect(stderr).toContain("no content extracted")
  })

  it.each(["json", "jsonl"])("marks empty %s output and preserves strict exit status", (format) => {
    const { status, stdout, stderr } = run(["-", "--format", format, "--strict", "--quality"], EMPTY_HTML)
    expect(status).toBe(3)
    expect(JSON.parse(stdout)).toMatchObject({
      extractionEmpty: true,
      content: "",
      wordCount: 0,
      readTime: "0 min",
      quality: { verdict: "poor" },
    })
    expect(stderr).toContain("no content extracted")
    const success = run(["-", "--format", format, "--budget", "10"], ARTICLE_HTML)
    expect(success.status).toBe(0)
    expect(JSON.parse(success.stdout).extractionEmpty).toBeUndefined()
  })

  it("marks empty XML output without changing the default exit status", () => {
    const { status, stdout } = run(["-", "--format", "xml"], EMPTY_HTML)
    expect(status).toBe(0)
    expect(stdout).toContain("<extractionEmpty>true</extractionEmpty>")
    expect(stdout).toContain("<readTime>0 min</readTime>")
  })

  it("exits 3 on empty extraction with --strict", () => {
    const { status } = run(["-", "--strict"], EMPTY_HTML)
    expect(status).toBe(3)
  })

  it("extracts a single property with -p", () => {
    const { status, stdout } = run(["-", "-p", "title"], ARTICLE_HTML)
    expect(status).toBe(0)
    expect(stdout.trim()).toBe("CLI Test Article")
  })

  it("exits 1 and writes Error to stderr for an unknown property", () => {
    const { status, stderr } = run(["-", "-p", "nonexistent"], ARTICLE_HTML)
    expect(status).toBe(1)
    expect(stderr).toContain('Property "nonexistent" not found')
  })

  it("exits 2 when --check is used on stdin", () => {
    const { status, stderr } = run(["-", "--check"], EMPTY_HTML)
    expect(status).toBe(2)
    expect(stderr).toContain("--check is only supported for URLs")
  })

  it("prints version", () => {
    const out = execFileSync("node", [CLI, "--version"], { encoding: "utf-8" })
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

// End-to-end batch coverage against a real loopback HTTP server. Routes are
// mutable per test so a second run can "recover" URLs that failed the first.
const BATCH_ARTICLE = (title: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${"<p>Meaningful paragraph with enough words to pass extraction thresholds and be kept.</p>".repeat(
    12,
  )}</main></body></html>`
const BATCH_EMPTY = '<!doctype html><html><head><title>Shell</title></head><body><div id="root"></div></body></html>'

// spawnSync blocks the parent event loop, which would starve the in-process
// HTTP server these tests rely on; use async spawn so the loop stays live.
const runAsync = (args: string[], stdin?: string): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  new Promise((settle, reject) => {
    const child = spawn("node", [CLI, ...args], {
      env: { ...process.env, RDRR_NO_HISTORY: "1" },
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("batch CLI timed out"))
    }, 30_000)
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")))
    child.on("error", reject)
    child.on("close", (status) => {
      clearTimeout(timer)
      settle({ status, stdout, stderr })
    })
    if (stdin !== undefined) child.stdin.end(stdin)
    else child.stdin.end()
  })

describe.skipIf(!existsSync(CLI))("batch subcommand (built dist)", () => {
  let server: Server
  let baseUrl: string
  const routes = new Map<string, { status?: number; body?: string; delayMs?: number }>()

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const route = routes.get(req.url ?? "/")
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

  beforeAll(async () => {
    server = createServer(handler)
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => await new Promise<void>((done) => server.close(() => done())))

  const withTempDir = async (fn: (dir: string) => Promise<void> | void): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), "rdrr-cli-batch-"))
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it("fails explicitly when the manifest has no usable URLs", async () => {
    await withTempDir(async (dir) => {
      const manifest = join(dir, "urls.txt")
      writeFileSync(manifest, "# just a comment\n\n   \n")
      const { status, stdout, stderr } = await runAsync(["batch", manifest, "--out-dir", join(dir, "out")])
      expect(status).toBe(2)
      expect(stdout).toBe("")
      expect(stderr).toContain("no usable URLs")
    })
  })

  it("accepts the manifest on stdin and keeps stdout empty", async () => {
    await withTempDir(async (dir) => {
      routes.set("/a", { body: BATCH_ARTICLE("A") })
      const manifest = `# comment\n\n${baseUrl}/a\n`
      const { status, stdout, stderr } = await runAsync(
        ["batch", "-", "--out-dir", dir, "--allow-private-networks"],
        manifest,
      )
      expect(status).toBe(0)
      expect(stdout).toBe("")
      expect(stderr).toContain("Batch summary:")
      expect(stderr).toContain("success: 1")
      const results = readFileSync(join(dir, "results.jsonl"), "utf-8").trim().split("\n")
      expect(results).toHaveLength(1)
      const record = JSON.parse(results[0]!)
      expect(existsSync(join(dir, record.outputFile))).toBe(true)
      expect(readFileSync(join(dir, "progress.jsonl"), "utf-8")).toContain(record.url)
    })
  })

  it("counts duplicates distinctly from processed URLs", async () => {
    await withTempDir(async (dir) => {
      routes.set("/a", { body: BATCH_ARTICLE("A") })
      const manifest = `${baseUrl}/a\n${baseUrl}/a\n`
      const { status, stderr } = await runAsync(["batch", "-", "--out-dir", dir, "--allow-private-networks"], manifest)
      expect(status).toBe(0)
      expect(stderr).toContain("total: 1")
      expect(stderr).toContain("duplicates: 1")
    })
  })

  it("separates empty and failed lines on stderr and exits 1 on failure", async () => {
    await withTempDir(async (dir) => {
      routes.set("/empty", { body: BATCH_EMPTY })
      const { status, stderr } = await runAsync(
        ["batch", "-", "--out-dir", dir, "--allow-private-networks"],
        `${baseUrl}/empty\n${baseUrl}/missing\n`,
      )
      expect(status).toBe(1)
      expect(stderr).toMatch(/^Empty:/m)
      expect(stderr).toMatch(/^Failed:/m)
      expect(stderr).toContain("empty: 1")
      expect(stderr).toContain("failed: 1")
    })
  })

  it("exits 3 under --strict when any entry is empty, including an all-empty batch", async () => {
    await withTempDir(async (dir) => {
      routes.set("/empty", { body: BATCH_EMPTY })
      routes.set("/emptier", { body: BATCH_EMPTY })

      const oneEmpty = await runAsync(
        ["batch", "-", "--out-dir", join(dir, "one"), "--strict", "--allow-private-networks"],
        `${baseUrl}/empty\n`,
      )
      expect(oneEmpty.status).toBe(3)

      const allEmpty = await runAsync(
        ["batch", "-", "--out-dir", join(dir, "all"), "--strict", "--allow-private-networks"],
        `${baseUrl}/empty\n${baseUrl}/emptier\n`,
      )
      expect(allEmpty.status).toBe(3)
      expect(allEmpty.stderr).toContain("empty: 2")

      // Without --strict the same all-empty batch completes with exit 0.
      const lax = await runAsync(
        ["batch", "-", "--out-dir", join(dir, "lax"), "--allow-private-networks"],
        `${baseUrl}/empty\n${baseUrl}/emptier\n`,
      )
      expect(lax.status).toBe(0)
    })
  })

  it("resumes by skipping successes and reprocessing failures", async () => {
    await withTempDir(async (dir) => {
      routes.set("/ok", { body: BATCH_ARTICLE("OK") })
      const manifestPath = join(dir, "urls.txt")
      writeFileSync(manifestPath, `${baseUrl}/ok\n${baseUrl}/missing\n`)
      const first = await runAsync(["batch", manifestPath, "--out-dir", join(dir, "out"), "--allow-private-networks"])
      expect(first.status).toBe(1)

      routes.set("/missing", { body: BATCH_ARTICLE("Recovered") })
      const second = await runAsync(["batch", manifestPath, "--out-dir", join(dir, "out"), "--allow-private-networks"])
      expect(second.status).toBe(0)
      expect(second.stderr).toContain("skipped: 1")
      expect(second.stderr).toContain("success: 1")
      expect(second.stderr).toContain("failed: 0")
    })
  })

  it("rejects concurrency above the hard cap", async () => {
    await withTempDir(async (dir) => {
      routes.set("/a", { body: BATCH_ARTICLE("A") })
      const { status, stderr } = await runAsync(
        ["batch", "-", "--out-dir", dir, "--concurrency", "99", "--allow-private-networks"],
        `${baseUrl}/a\n`,
      )
      expect(status).not.toBe(0)
      expect(stderr).toContain("at most 16")
    })
  })

  it("writes one file per entry in the requested format", async () => {
    await withTempDir(async (dir) => {
      routes.set("/a", { body: BATCH_ARTICLE("A") })
      const { status } = await runAsync(
        ["batch", "-", "--out-dir", dir, "--format", "json", "--allow-private-networks"],
        `${baseUrl}/a\n`,
      )
      expect(status).toBe(0)
      const files = readFileSync(join(dir, "results.jsonl"), "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).outputFile as string)
      expect(files).toHaveLength(1)
      expect(files[0]!.endsWith(".json")).toBe(true)
      const body = JSON.parse(readFileSync(join(dir, files[0]!), "utf-8"))
      expect(body.title).toBe("A")
    })
  })
})
