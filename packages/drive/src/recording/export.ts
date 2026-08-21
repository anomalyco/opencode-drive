import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, extname } from "node:path"
import { applyClips, labelAt, type RecordingAnnotation, type RecordingClip } from "./edit.js"
import { encodeFrames } from "./encode.js"
import { progressReporter } from "./frame-rate.js"
import { replayRecording, type ReplayOptions } from "./replay.js"
import { CellHeight, CellWidth, FooterHeight, formatTimecode, renderFrame } from "./render.js"

export interface ExportRecordingOptions extends ReplayOptions {
  ffmpegPath?: string
  header?: string | ((atMs: number) => string)
  /**
   * Burn a footer bar into every frame: segment label bottom-left, timecode
   * and brand bottom-right. Implied by `annotations` or `clips`.
   */
  footer?: boolean | { brand?: string }
  /** Labelled instants on the raw recording timeline. */
  annotations?: ReadonlyArray<RecordingAnnotation>
  /** Kept segments of the raw recording timeline, concatenated in order. */
  clips?: ReadonlyArray<RecordingClip>
  onProgress?: (percent: number) => void
  signal?: AbortSignal
}

export interface ExportRecordingResult {
  frames: number
  durationMs: number
  width: number
  height: number
}

export async function exportRecording(
  timelinePath: string,
  outputPath: string,
  options: ExportRecordingOptions = {},
): Promise<ExportRecordingResult> {
  options.signal?.throwIfAborted()
  const replayed = await replayRecording(timelinePath, options)
  options.signal?.throwIfAborted()
  const annotations = options.annotations ?? []
  const samples =
    options.clips && options.clips.length > 0
      ? applyClips(replayed, options.clips)
      : replayed.map((sample) => ({ ...sample, label: undefined }))
  const footerEnabled =
    options.footer === false
      ? false
      : options.footer !== undefined || annotations.length > 0 || (options.clips?.length ?? 0) > 0
  const brand = typeof options.footer === "object" ? options.footer.brand : undefined
  const footer = (sample: { atMs: number; sourceAtMs: number; label?: string }) =>
    footerEnabled
      ? {
          label: sample.label ?? labelAt(annotations, sample.sourceAtMs),
          timecodeMs: sample.atMs,
          brand,
        }
      : undefined
  const final = samples.at(-1)!
  let cols = 0
  let rows = 0
  for (const sample of samples) {
    cols = Math.max(cols, sample.frame.cols)
    rows = Math.max(rows, sample.frame.rows)
  }
  const extension = extname(outputPath).toLowerCase()
  const header = (atMs: number) =>
    typeof options.header === "function" ? options.header(atMs) : options.header
  const progress = progressReporter(options.onProgress)
  await mkdir(dirname(outputPath), { recursive: true })

  if (extension === ".png") {
    await writeFile(
      outputPath,
      renderFrame(final.frame, { cols, rows, header: header(final.atMs), footer: footer(final) }),
      { signal: options.signal },
    )
    progress(100)
  } else if (extension === ".mp4") {
    const frameKeys = new WeakMap<object, string>()
    await encodeFrames(
      samples.map((sample) => {
        const label = header(sample.atMs)
        const overlay = footer(sample)
        let frameKey = frameKeys.get(sample.frame)
        if (frameKey === undefined) {
          frameKey = createHash("sha256").update(JSON.stringify(sample.frame)).digest("hex")
          frameKeys.set(sample.frame, frameKey)
        }
        return {
          atMs: sample.atMs,
          key: JSON.stringify([
            frameKey,
            label,
            overlay ? [overlay.label, overlay.brand, formatTimecode(overlay.timecodeMs)] : undefined,
          ]),
          render: () => renderFrame(sample.frame, { cols, rows, header: label, footer: overlay }),
        }
      }),
      outputPath,
      options,
    )
  } else {
    throw new Error(`Unsupported recording output extension: ${extension || "(none)"}`)
  }

  return {
    frames: samples.length,
    durationMs: final.atMs,
    width: cols * CellWidth,
    height: rows * CellHeight + (options.header ? 40 : 0) + (footerEnabled ? FooterHeight : 0),
  }
}
