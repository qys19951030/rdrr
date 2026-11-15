import { describe, expect, it } from "vitest"
import { ManifestError, parseManifest } from "../manifest"

describe("parseManifest", () => {
  it("parses one URL per line and ignores blank lines and # comments", () => {
    const text = [
      "# leading comment",
      "https://a.example/post",
      "",
      "   ",
      "  # indented comment",
      "b.example/page",
      "http://c.example/x",
    ].join("\n")

    const { entries, duplicates } = parseManifest(text)
    expect(entries.map((e) => e.url)).toEqual([
      "https://a.example/post",
      "https://b.example/page",
      "http://c.example/x",
    ])
    expect(duplicates).toBe(0)
  })

  it("prepends https when the scheme is missing", () => {
    const { entries } = parseManifest("example.com/docs")
    expect(entries[0]?.url).toBe("https://example.com/docs")
    expect(entries[0]?.site).toBe("example.com")
  })

  it("dedups repeated addresses and counts the repeats", () => {
    const text = ["https://a.example/1", "https://a.example/1", "a.example/1", "https://b.example/2"].join("\n")
    const { entries, duplicates } = parseManifest(text)
    expect(entries.map((e) => e.url)).toEqual(["https://a.example/1", "https://b.example/2"])
    expect(duplicates).toBe(2)
  })

  it("treats hash-only variants as the same address", () => {
    const { entries, duplicates } = parseManifest(["https://a.example/p#one", "https://a.example/p#two"].join("\n"))
    expect(entries).toHaveLength(1)
    expect(duplicates).toBe(1)
  })

  it("reports the line number of an invalid URL", () => {
    const text = ["https://a.example/1", "not a url at all"].join("\n")
    expect(() => parseManifest(text)).toThrow(ManifestError)
    expect(() => parseManifest(text)).toThrow("line 2")
  })

  it("rejects non-http schemes", () => {
    expect(() => parseManifest("ftp://a.example/file")).toThrow(ManifestError)
  })

  it("fails explicitly on an empty manifest", () => {
    expect(() => parseManifest("")).toThrow("no usable URLs")
    expect(() => parseManifest("# only comments\n\n  \n")).toThrow("no usable URLs")
  })
})
