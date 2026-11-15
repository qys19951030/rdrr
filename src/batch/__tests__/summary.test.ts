import { describe, expect, it } from "vitest"
import type { BatchSummary } from "../types"
import { renderSummary } from "../summary"

const baseSummary = (overrides?: Partial<BatchSummary>): BatchSummary => ({
  total: 3,
  success: 1,
  empty: 1,
  failed: 1,
  skipped: 0,
  duplicates: 2,
  siteCount: 2,
  sites: {
    "a.example": { tasks: 2, totalDurationMs: 200 },
    "b.example": { tasks: 1, totalDurationMs: 300 },
  },
  ...overrides,
})

describe("renderSummary", () => {
  it("reports every required counter including duplicates and skip split", () => {
    const text = renderSummary(baseSummary({ skipped: 4 }))
    expect(text).toContain("total: 3")
    expect(text).toContain("success: 1")
    expect(text).toContain("empty: 1")
    expect(text).toContain("failed: 1")
    expect(text).toContain("skipped: 4")
    expect(text).toContain("duplicates: 2")
    expect(text).toContain("sites: 2")
  })

  it("includes per-site task counts and average duration", () => {
    const text = renderSummary(baseSummary())
    expect(text).toMatch(/a\.example: 2 task\(s\), avg 100 ms/)
    expect(text).toMatch(/b\.example: 1 task\(s\), avg 300 ms/)
  })

  it("lists sites alphabetically for stable output", () => {
    const text = renderSummary(baseSummary())
    expect(text.indexOf("a.example")).toBeLessThan(text.indexOf("b.example"))
  })
})
