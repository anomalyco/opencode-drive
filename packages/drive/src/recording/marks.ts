import { appendFile, stat } from "node:fs/promises"
import type { RecordingAnnotation } from "./edit.js"

/** Sidecar file holding wall-clock marks recorded next to a timeline. */
export function marksPath(timeline: string) {
  return `${timeline.replace(/\.jsonl$/, "")}.marks.jsonl`
}

/** Append a wall-clock mark for a running recording. */
export async function appendMark(timeline: string, label: string) {
  if (typeof label !== "string") throw new Error("mark label must be a string")
  await appendFile(marksPath(timeline), `${JSON.stringify({ wallMs: Date.now(), label })}\n`)
}

/**
 * Convert recorded wall-clock marks into raw-timeline annotations, anchored
 * to the timeline file's creation instant (the recorder's time zero, within
 * a few milliseconds).
 */
export async function loadAnnotations(timeline: string): Promise<RecordingAnnotation[]> {
  const file = Bun.file(marksPath(timeline))
  if (!(await file.exists())) return []
  const anchor = (await stat(timeline)).birthtimeMs
  // Filesystems without birthtime support report 0 (or garbage), which would
  // turn every mark into a raw epoch offset. Fail loudly rather than export
  // a video with wildly misplaced labels.
  if (!Number.isFinite(anchor) || anchor <= 0)
    throw new Error(`Recording marks need filesystem birthtime support (got ${anchor} for ${timeline})`)
  const annotations: RecordingAnnotation[] = []
  for (const line of (await file.text()).split("\n")) {
    if (line.trim() === "") continue
    const parsed: unknown = JSON.parse(line)
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { wallMs?: unknown }).wallMs !== "number" ||
      typeof (parsed as { label?: unknown }).label !== "string"
    )
      throw new Error(`Invalid recording mark: ${line}`)
    const mark = parsed as { wallMs: number; label: string }
    annotations.push({ atMs: Math.max(0, mark.wallMs - anchor), label: mark.label })
  }
  return annotations
}
