import { appendFile, stat } from "node:fs/promises"
import type { Frontend } from "../client/protocol.js"
import type { RecordingClip } from "./edit.js"

export interface RecordingKeypress {
  readonly atMs: number
  readonly label: string
  readonly untilMs?: number
}

export const KeypressDisplayMs = 1_200

export function keypressesPath(timeline: string) {
  return `${timeline.replace(/\.jsonl$/, "")}.keypresses.jsonl`
}

export async function appendKeypress(timeline: string, label: string) {
  await appendFile(
    keypressesPath(timeline),
    `${JSON.stringify({ wallMs: Date.now(), label })}\n`,
  )
}

export async function loadKeypresses(
  timeline: string,
): Promise<RecordingKeypress[]> {
  const file = Bun.file(keypressesPath(timeline))
  if (!(await file.exists())) return []
  const anchor = (await stat(timeline)).birthtimeMs
  return parse(await file.text()).map((keypress) => ({
    atMs: Math.max(0, keypress.wallMs - anchor),
    label: keypress.label,
  }))
}

export async function loadRecentKeypresses(timeline: string, now = Date.now()) {
  const file = Bun.file(keypressesPath(timeline))
  if (!(await file.exists())) return []
  return parse(await file.text())
    .filter((keypress) => keypress.wallMs <= now && keypress.wallMs > now - KeypressDisplayMs)
    .slice(-3)
    .map((keypress) => keypress.label)
}

export function activeKeypresses(
  keypresses: ReadonlyArray<RecordingKeypress>,
  atMs: number,
) {
  return keypresses
    .filter(
      (keypress) =>
        keypress.atMs <= atMs &&
        atMs < (keypress.untilMs ?? keypress.atMs + KeypressDisplayMs),
    )
    .slice(-3)
    .map((keypress) => keypress.label)
}

export function injectKeypressSamples<Sample extends { readonly atMs: number }>(
  samples: ReadonlyArray<Sample>,
  keypresses: ReadonlyArray<RecordingKeypress>,
) {
  if (samples.length === 0 || keypresses.length === 0) return [...samples]
  const result = new Map(samples.map((sample) => [sample.atMs, sample]))
  for (const keypress of keypresses) {
    for (const atMs of [
      keypress.atMs,
      keypress.untilMs ?? keypress.atMs + KeypressDisplayMs,
    ]) {
      if (result.has(atMs)) continue
      const frame = samples.findLast((sample) => sample.atMs <= atMs) ?? samples[0]
      if (frame) result.set(atMs, { ...frame, atMs })
    }
  }
  return [...result.values()].sort((left, right) => left.atMs - right.atMs)
}

export function mapKeypresses(
  keypresses: ReadonlyArray<RecordingKeypress>,
  clips: ReadonlyArray<RecordingClip> | undefined,
) {
  if (!clips || clips.length === 0) return keypresses
  const mapped: RecordingKeypress[] = []
  let offset = 0
  for (const clip of clips) {
    const speed = clip.speed ?? 1
    const clipEnd = offset + (clip.toMs - clip.fromMs) / speed + (clip.holdMs ?? 0)
    for (const keypress of keypresses) {
      if (keypress.atMs < clip.fromMs || keypress.atMs > clip.toMs) continue
      const atMs = offset + (keypress.atMs - clip.fromMs) / speed
      mapped.push({
        atMs,
        label: keypress.label,
        untilMs: Math.min(atMs + KeypressDisplayMs, clipEnd),
      })
    }
    offset = clipEnd
  }
  return mapped
}

export function formatPress(key: string, modifiers?: Frontend.KeyModifiers) {
  const names = [
    modifiers?.ctrl ? "Ctrl" : undefined,
    modifiers?.shift ? "Shift" : undefined,
    modifiers?.meta ? "Alt" : undefined,
    modifiers?.super ? "Super" : undefined,
    modifiers?.hyper ? "Hyper" : undefined,
    formatKey(key),
  ]
  return names.filter((name): name is string => name !== undefined).join(" + ")
}

export function formatArrow(direction: Frontend.ArrowParams["direction"]) {
  return { up: "↑", down: "↓", left: "←", right: "→" }[direction]
}

function formatKey(key: string) {
  const normalized = key.toLowerCase()
  if (normalized === "escape" || key === "\u001b") return "Esc"
  if (normalized === "enter" || normalized === "return") return "Enter"
  if (normalized === "space" || key === " ") return "Space"
  if (normalized === "tab") return "Tab"
  if (normalized === "backspace") return "⌫"
  if (normalized === "delete") return "Del"
  return key.length === 1 ? key.toUpperCase() : key
}

function parse(contents: string) {
  const keypresses: Array<{ wallMs: number; label: string }> = []
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue
    const parsed: unknown = JSON.parse(line)
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("wallMs" in parsed) ||
      typeof parsed.wallMs !== "number" ||
      !("label" in parsed) ||
      typeof parsed.label !== "string"
    )
      throw new Error(`Invalid recording keypress: ${line}`)
    keypresses.push({ wallMs: parsed.wallMs, label: parsed.label })
  }
  return keypresses
}
