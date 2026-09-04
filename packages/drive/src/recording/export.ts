import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, extname } from "node:path"
import { applyClips, labelAt, type RecordingAnnotation, type RecordingClip } from "./edit.js"
import { encodeFrames } from "./encode.js"
import { progressReporter } from "./frame-rate.js"
import { replayRecording, type ReplayOptions } from "./replay.js"
import { CellHeight, CellWidth, FooterHeight, formatTimecode, renderFrame } from "./render.js"
import { loadPointers, pointerAt, PointerOverlayOptions } from "./pointer.js"
import {
  activeKeypresses,
  injectKeypressSamples,
  mapKeypresses,
  type RecordingKeypress,
} from "./keypresses.js"

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
  /** Semantic key presses to display briefly over the terminal. */
  keypresses?: ReadonlyArray<RecordingKeypress>
  /** Animate actual mouse input from the recording sidecar. Off by default. */
  pointerOverlay?: boolean | PointerOverlayOptions
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
  const keypresses = options.keypresses ?? []
  const pointerOptions = options.pointerOverlay
    ? PointerOverlayOptions.make(options.pointerOverlay === true ? {} : options.pointerOverlay)
    : undefined
  const pointers = pointerOptions ? await loadPointers(timelinePath) : []
  const edited =
    options.clips && options.clips.length > 0
      ? applyClips(replayed, options.clips)
      : replayed.map((sample) => ({ ...sample, playbackAtMs: sample.sourceAtMs, label: undefined }))
  // Even an unedited video has a raw-time origin: replay trims blank startup
  // or starts at startAtMs. Overlay times must use that same retained range.
  const outputKeypresses = mapKeypresses(keypresses, options.clips?.length ? options.clips : [{
    fromMs: replayed[0]!.sourceAtMs,
    toMs: replayed.at(-1)!.sourceAtMs,
  }])
  const originalSamples = new Set(edited)
  const samples = injectKeypressSamples(edited, outputKeypresses).map((sample) => {
    if (originalSamples.has(sample)) return sample
    const previous = edited.findLast((frame) => frame.atMs <= sample.atMs)
    const next = edited.find((frame) => frame.atMs > sample.atMs)
    if (!previous || !next || sample.atMs === previous.atMs) return sample
    return {
      ...sample,
      playbackAtMs: previous.playbackAtMs + (next.playbackAtMs - previous.playbackAtMs) *
        (sample.atMs - previous.atMs) / (next.atMs - previous.atMs),
    }
  })
  const footerEnabled =
    options.footer === false
      ? false
      : options.footer !== undefined || annotations.length > 0 || (options.clips?.length ?? 0) > 0
  const brand = typeof options.footer === "object" ? options.footer.brand : undefined
  const footer = (sample: { atMs: number; playbackAtMs: number; label?: string }) =>
    footerEnabled
      ? {
          label: sample.label ?? labelAt(annotations, sample.playbackAtMs),
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
      renderFrame(final.frame, {
        cols,
        rows,
        header: header(final.atMs),
        footer: footer(final),
        keys: activeKeypresses(outputKeypresses, final.atMs),
        pointer: pointerOptions ? pointerAt(pointers, final.playbackAtMs, pointerOptions) : undefined,
      }),
      { signal: options.signal },
    )
    progress(100)
  } else if (extension === ".mp4") {
    const frameKeys = new WeakMap<object, string>()
    await encodeFrames(
      samples.map((sample) => {
        const label = header(sample.atMs)
        const overlay = footer(sample)
        const keys = activeKeypresses(outputKeypresses, sample.atMs)
        const pointer = pointerOptions ? pointerAt(pointers, sample.playbackAtMs, pointerOptions) : undefined
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
            keys,
            pointer,
          ]),
          render: () => renderFrame(sample.frame, { cols, rows, header: label, footer: overlay, keys, pointer }),
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
