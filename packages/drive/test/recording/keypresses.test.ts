import { afterEach, expect, test } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  activeKeypresses,
  appendKeypress,
  formatArrow,
  formatPress,
  injectKeypressSamples,
  keypressesPath,
  loadKeypresses,
  loadRecentKeypresses,
  mapKeypresses,
  renderFrame,
} from "../../src/recording/index.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  )
})

async function timeline() {
  const directory = await mkdtemp(join(tmpdir(), "drive-keypress-test-"))
  directories.push(directory)
  const path = join(directory, "recording-0.jsonl")
  await writeFile(
    path,
    `${JSON.stringify({ type: "header", version: 1, cols: 40, rows: 10, encoding: "base64" })}\n`,
  )
  return path
}

test("formats semantic key presses", () => {
  expect(formatPress("p", { ctrl: true, shift: true })).toBe("Ctrl + Shift + P")
  expect(formatPress("escape")).toBe("Esc")
  expect(formatPress(" ")).toBe("Space")
  expect(formatArrow("up")).toBe("↑")
})

test("keypresses round-trip through the recording sidecar", async () => {
  const path = await timeline()
  expect(await loadKeypresses(path)).toEqual([])
  await appendKeypress(path, "Ctrl + P")
  await appendKeypress(path, "Enter")

  const entries = await loadKeypresses(path)
  expect(entries.map((entry) => entry.label)).toEqual(["Ctrl + P", "Enter"])
  expect(await loadRecentKeypresses(path)).toEqual(["Ctrl + P", "Enter"])
  expect(keypressesPath(path)).toBe(path.replace(/\.jsonl$/, ".keypresses.jsonl"))
})

test("shows only the three recent key presses", () => {
  const keypresses = [
    { atMs: 0, label: "old" },
    { atMs: 1_000, label: "A" },
    { atMs: 1_100, label: "B" },
    { atMs: 1_200, label: "C" },
    { atMs: 1_300, label: "D" },
  ]
  expect(activeKeypresses(keypresses, 1_400)).toEqual(["B", "C", "D"])
  expect(activeKeypresses(keypresses, 2_501)).toEqual([])
})

test("adds samples for a final non-rendering keypress and its expiry", () => {
  const samples = [{ atMs: 0, value: "first" }, { atMs: 100, value: "final" }]
  expect(
    injectKeypressSamples(samples, [{ atMs: 150, label: "Enter" }]),
  ).toEqual([
    { atMs: 0, value: "first" },
    { atMs: 100, value: "final" },
    { atMs: 150, value: "final" },
    { atMs: 1_350, value: "final" },
  ])
})

test("keeps display duration stable across clip speed and bounds it to the clip", () => {
  const keypresses = [{ atMs: 1_000, label: "Enter" }]
  expect(
    mapKeypresses(keypresses, [
      { fromMs: 0, toMs: 2_000, speed: 2, holdMs: 2_000 },
      { fromMs: 500, toMs: 1_000, speed: 0.5 },
    ]),
  ).toEqual([
    { atMs: 500, untilMs: 1_700, label: "Enter" },
    { atMs: 4_000, untilMs: 4_000, label: "Enter" },
  ])
})

test("renders keypress pills without changing capture dimensions", () => {
  const frame = {
    cols: 40,
    rows: 10,
    cursor: { row: 0, col: 0, visible: false },
    lines: Array.from({ length: 10 }, () => ({
      spans: [{ text: " ".repeat(40), width: 40, fg: 0xffffff, bg: 0x080808, attributes: 0 }],
    })),
  }
  const plain = renderFrame(frame)
  const overlaid = renderFrame(frame, { keys: ["Ctrl + P", "Enter"] })

  expect(overlaid.readUInt32BE(16)).toBe(plain.readUInt32BE(16))
  expect(overlaid.readUInt32BE(20)).toBe(plain.readUInt32BE(20))
  expect(overlaid).not.toEqual(plain)
})

test("keeps long keypress labels inside a small viewport", () => {
  const frame = {
    cols: 8,
    rows: 2,
    cursor: { row: 1, col: 4, visible: true },
    lines: Array.from({ length: 2 }, () => ({
      spans: [{ text: " ".repeat(8), width: 8, fg: 0xffffff, bg: 0x080808, attributes: 0 }],
    })),
  }
  const image = renderFrame(frame, {
    keys: ["Ctrl + Shift + Super + ExceptionallyLongKey"],
  })
  expect(image.readUInt32BE(16)).toBe(80)
  expect(image.readUInt32BE(20)).toBe(40)
})
