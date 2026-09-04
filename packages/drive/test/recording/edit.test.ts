import { describe, expect, test } from "vitest"
import { applyClips, labelAt } from "../../src/recording/edit.js"
import type { SampledFrame } from "../../src/recording/types.js"

function frame(text: string): SampledFrame["frame"] {
  return {
    cols: text.length,
    rows: 1,
    cursor: { row: 0, col: 0, visible: false },
    lines: [{ spans: [{ text, fg: 0, bg: 0, attributes: 0, width: text.length }] }],
  }
}

function sample(sourceAtMs: number, text: string): SampledFrame {
  return { atMs: sourceAtMs, sourceAtMs, frame: frame(text) }
}

describe("labelAt", () => {
  const annotations = [
    { atMs: 100, label: "typing" },
    { atMs: 500, label: "waiting" },
    { atMs: 900, label: "" },
  ]

  test("resolves the latest annotation at or before the instant", () => {
    expect(labelAt(annotations, 50)).toBeUndefined()
    expect(labelAt(annotations, 100)).toBe("typing")
    expect(labelAt(annotations, 499)).toBe("typing")
    expect(labelAt(annotations, 500)).toBe("waiting")
  })

  test("an empty label clears the caption", () => {
    expect(labelAt(annotations, 1200)).toBeUndefined()
  })

  test("later duplicates win regardless of input order", () => {
    expect(labelAt([{ atMs: 10, label: "b" }, { atMs: 10, label: "a" }], 20)).toBe("a")
  })
})

describe("applyClips", () => {
  const samples = [
    sample(0, "zero"),
    sample(100, "one"),
    sample(200, "two"),
    sample(300, "three"),
    sample(400, "four"),
  ]

  test("keeps the opener frame and the samples inside the range", () => {
    const edited = applyClips(samples, [{ fromMs: 100, toMs: 300 }])
    expect(edited.map((entry) => entry.sourceAtMs)).toEqual([100, 200, 300])
    expect(edited.map((entry) => entry.atMs)).toEqual([0, 100, 200])
  })

  test("uses the last sample at-or-before fromMs as the opener", () => {
    const edited = applyClips(samples, [{ fromMs: 150, toMs: 300 }])
    expect(edited.map((entry) => entry.sourceAtMs)).toEqual([100, 200, 300])
    expect(edited[0]!.atMs).toBe(0)
    expect(edited[0]!.playbackAtMs).toBe(150)
    expect(edited[0]!.frame).toBe(samples[1]!.frame)
  })

  test("separates off-grid playback boundaries from borrowed pixels through reordered clips and holds", () => {
    const edited = applyClips(samples, [
      { fromMs: 310, toMs: 390, speed: 2, holdMs: 30 },
      { fromMs: 110, toMs: 190 },
    ])
    expect(edited.map((entry) => [entry.atMs, entry.sourceAtMs, entry.playbackAtMs])).toEqual([
      [0, 300, 310], [40, 300, 390], [70, 300, 390],
      [70, 100, 110], [150, 100, 190],
    ])
  })

  test("speed rescales the clip and holds freeze the last frame", () => {
    const edited = applyClips(samples, [
      { fromMs: 0, toMs: 200, speed: 2, holdMs: 500, label: "fast" },
      { fromMs: 300, toMs: 400, label: "slow" },
    ])
    expect(edited.map((entry) => [entry.atMs, entry.sourceAtMs, entry.label])).toEqual([
      [0, 0, "fast"],
      [50, 100, "fast"],
      [100, 200, "fast"],
      [600, 200, "fast"],
      [600, 300, "slow"],
      [700, 400, "slow"],
    ])
  })

  test("preserves quiet time up to the clip end", () => {
    const edited = applyClips(samples.slice(0, 2), [{ fromMs: 0, toMs: 500 }])
    expect(edited.at(-1)).toMatchObject({ atMs: 500, sourceAtMs: 100 })
  })

  test("rejects invalid clips", () => {
    expect(() => applyClips(samples, [])).toThrow("clips must not be empty")
    expect(() => applyClips(samples, [{ fromMs: 100, toMs: 0 }])).toThrow("fromMs <= toMs")
    expect(() => applyClips(samples, [{ fromMs: 0, toMs: 1, speed: 0 }])).toThrow("positive finite")
  })
})
