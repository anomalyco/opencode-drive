import type { ExportRecordingOptions } from "./export.js"

export interface RecordingPaths {
  readonly timeline: string
  readonly video: string
}

export async function finalizeRecording(
  timeline: string,
  expected: RecordingPaths,
  options?: ExportRecordingOptions,
) {
  if (timeline !== expected.timeline)
    throw new Error(`OpenCode returned an unexpected recording path: ${timeline}`)
  if (!(await Bun.file(timeline).exists()))
    throw new Error(`OpenCode recording timeline was not created: ${timeline}`)
  const { exportRecording } = await import("./export.js")
  // Marks recorded during the run become footer annotations automatically.
  const annotations =
    options?.annotations ?? (await (await import("./marks.js")).loadAnnotations(timeline))
  const keypresses =
    options?.keypresses ?? (await (await import("./keypresses.js")).loadKeypresses(timeline))
  await exportRecording(timeline, expected.video, { ...options, annotations, keypresses })
  return expected.video
}
