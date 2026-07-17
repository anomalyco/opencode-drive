import { describe, expect, test } from "bun:test"
import type { DriveManifest, Variant } from "./schema"
import {
  captureSetId,
  captureSetLabel,
  mergeCaptureHistory,
  parseCaptureOptions,
  sortCaptureSets,
} from "../scripts/capture-sets"

const set = (id: string, committedAt: string): Variant => ({
  id,
  label: id,
  source: "opencode",
  revision: id.repeat(40).slice(0, 40),
  ref: id,
  committedAt,
})

describe("capture revision sets", () => {
  test("parses repeated revisions and themes", () => {
    expect(parseCaptureOptions([
      "--opencode", "./opencode",
      "--revision", "v2~1",
      "--revision", "v2",
      "--theme", "opencode",
      "--theme", "rosepine",
    ], "/default")).toEqual({
      opencode: `${process.cwd()}/opencode`,
      revisions: ["v2~1", "v2"],
      themes: ["opencode", "rosepine"],
    })
  })

  test("derives immutable commit and theme IDs", () => {
    expect(captureSetId("ABCDEF1234567890", undefined)).toBe("abcdef123456")
    expect(captureSetId("ABCDEF1234567890", "One Dark")).toBe("abcdef123456-one-dark")
    expect(captureSetLabel("abcdef1234567890", "rosepine")).toBe("abcdef1 / rosepine")
  })

  test("sorts newest commits first", () => {
    const older = set("a", "2026-07-16T12:00:00Z")
    const newer = set("b", "2026-07-17T12:00:00Z")
    expect(sortCaptureSets([older, newer]).map((variant) => variant.id)).toEqual(["b", "a"])
  })

  test("retains history and replaces a recaptured set", () => {
    const old = set("old", "2026-07-16T12:00:00Z")
    const current = set("current", "2026-07-17T12:00:00Z")
    const manifest: DriveManifest = {
      format: "opencode-terminal-frame-captures-v1",
      generatedBy: "test",
      variants: [current, old],
      captures: [{
        id: "home",
        title: "Home",
        category: "system",
        frames: [
          { variantId: "current", src: "captures/current/home.frame.json", cols: 1, rows: 1 },
          { variantId: "old", src: "captures/old/home.frame.json", cols: 1, rows: 1 },
        ],
      }],
    }
    const recaptured = { ...current, label: "current / rosepine", theme: "rosepine" }
    const merged = mergeCaptureHistory(manifest, [recaptured], [{
      id: "home",
      title: "Home",
      category: "system",
      frames: [{ variantId: "current", src: "captures/current/home.frame.json", cols: 2, rows: 2 }],
    }])

    expect(merged.variants.map((variant) => variant.id)).toEqual(["current", "old"])
    expect(merged.variants[0]?.theme).toBe("rosepine")
    expect(merged.captures[0]?.frames).toEqual([
      { variantId: "current", src: "captures/current/home.frame.json", cols: 2, rows: 2 },
      { variantId: "old", src: "captures/old/home.frame.json", cols: 1, rows: 1 },
    ])
  })
})
