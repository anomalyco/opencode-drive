import { afterEach, expect, test } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendMark, exportRecording, loadAnnotations, marksPath } from "../../src/recording/index.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function timeline() {
  const directory = await mkdtemp(join(tmpdir(), "drive-marks-test-"))
  directories.push(directory)
  const path = join(directory, "recording-0.jsonl")
  await writeFile(
    path,
    `${JSON.stringify({ type: "header", version: 1, cols: 4, rows: 2, encoding: "base64" })}\n` +
      `${JSON.stringify({ type: "output", at_ms: 0, data: Buffer.from("hi").toString("base64") })}\n`,
  )
  return path
}

test("marks round-trip into timeline annotations", async () => {
  const path = await timeline()
  expect(await loadAnnotations(path)).toEqual([])
  await appendMark(path, "phase one")
  await appendMark(path, "")
  const annotations = await loadAnnotations(path)
  expect(annotations.map((entry) => entry.label)).toEqual(["phase one", ""])
  for (const entry of annotations) {
    expect(entry.atMs).toBeGreaterThanOrEqual(0)
    expect(entry.atMs).toBeLessThan(60_000)
  }
  expect(marksPath(path)).toBe(path.replace(/\.jsonl$/, ".marks.jsonl"))
})

test("rejects malformed marks", async () => {
  const path = await timeline()
  await writeFile(marksPath(path), `${JSON.stringify({ wallMs: "soon", label: "x" })}\n`)
  await expect(loadAnnotations(path)).rejects.toThrow("Invalid recording mark")
})

test("annotations imply the footer and grow the canvas", async () => {
  const path = await timeline()
  const directory = join(path, "..")
  const plain = join(directory, "plain.png")
  const annotated = join(directory, "annotated.png")
  const before = await exportRecording(path, plain)
  const after = await exportRecording(path, annotated, {
    annotations: [{ atMs: 0, label: "the label" }],
  })
  expect(after.height).toBe(before.height + 40)
  expect((await readFile(annotated)).readUInt32BE(20)).toBe(after.height)
})

test("explicit footer false suppresses annotations", async () => {
  const path = await timeline()
  const output = join(path, "..", "suppressed.png")
  const result = await exportRecording(path, output, {
    footer: false,
    annotations: [{ atMs: 0, label: "hidden" }],
  })
  expect(result.height).toBe(40)
})

test("clips trim the exported video", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drive-clip-export-test-"))
  directories.push(directory)
  const path = join(directory, "recording-0.jsonl")
  await writeFile(
    path,
    [
      JSON.stringify({ type: "header", version: 1, cols: 4, rows: 2, encoding: "base64" }),
      JSON.stringify({ type: "output", at_ms: 0, data: Buffer.from("aa").toString("base64") }),
      JSON.stringify({ type: "output", at_ms: 1000, data: Buffer.from("bb").toString("base64") }),
      JSON.stringify({ type: "output", at_ms: 2000, data: Buffer.from("cc").toString("base64") }),
    ].join("\n") + "\n",
  )
  const output = join(directory, "clipped.png")
  const result = await exportRecording(path, output, {
    clips: [{ fromMs: 0, toMs: 1000, label: "start", holdMs: 250 }],
  })
  expect(result.durationMs).toBe(1250)
})
