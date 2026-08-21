import type { SampledFrame } from "./types.js"

/**
 * A labelled instant on the raw recording timeline. The label applies from
 * `atMs` until the next annotation (an empty label clears the caption).
 */
export interface RecordingAnnotation {
  readonly atMs: number
  readonly label: string
}

/**
 * One kept segment of the raw recording timeline. Clips are concatenated in
 * order; `speed` rescales the clip's duration, `holdMs` freezes its last
 * frame before the next clip, and `label` captions the whole clip
 * (overriding annotations).
 */
export interface RecordingClip {
  readonly fromMs: number
  readonly toMs: number
  readonly speed?: number
  readonly holdMs?: number
  readonly label?: string
}

export interface EditedSample extends SampledFrame {
  readonly label?: string
}

/** The annotation label active at `atMs` on the raw timeline, if any. */
export function labelAt(annotations: ReadonlyArray<RecordingAnnotation>, atMs: number) {
  let active: string | undefined
  let activeAt = Number.NEGATIVE_INFINITY
  for (const annotation of annotations) {
    if (annotation.atMs <= atMs && annotation.atMs >= activeAt) {
      active = annotation.label
      activeAt = annotation.atMs
    }
  }
  return active === "" ? undefined : active
}

/**
 * Stitch clips out of replayed samples. Sample `sourceAtMs` values address
 * the raw recording timeline; output `atMs` values form the edited video
 * timeline. Each clip keeps the samples inside `(fromMs, toMs]` plus the
 * last sample at-or-before `fromMs` as its opening frame, rescaled by
 * `speed` and concatenated after the previous clip (plus its `holdMs`).
 */
export function applyClips(
  samples: ReadonlyArray<SampledFrame>,
  clips: ReadonlyArray<RecordingClip>,
): EditedSample[] {
  if (clips.length === 0) throw new Error("clips must not be empty")
  const edited: EditedSample[] = []
  let offset = 0
  for (const clip of clips) {
    const speed = clip.speed ?? 1
    const holdMs = clip.holdMs ?? 0
    if (!Number.isFinite(speed) || speed <= 0) throw new Error("clip speed must be a positive finite number")
    if (!Number.isFinite(holdMs) || holdMs < 0) throw new Error("clip holdMs must be a non-negative finite number")
    if (!Number.isFinite(clip.fromMs) || !Number.isFinite(clip.toMs) || clip.toMs < clip.fromMs)
      throw new Error("clip range must satisfy fromMs <= toMs")
    const scale = (sourceAtMs: number) => offset + (Math.min(Math.max(sourceAtMs, clip.fromMs), clip.toMs) - clip.fromMs) / speed
    const opener = samples.findLast((sample) => sample.sourceAtMs <= clip.fromMs)
    const inside = samples.filter((sample) => sample.sourceAtMs > clip.fromMs && sample.sourceAtMs <= clip.toMs)
    const kept = opener ? [opener, ...inside] : inside
    for (const sample of kept) {
      edited.push({ ...sample, atMs: scale(sample.sourceAtMs), label: clip.label })
    }
    const clipEnd = offset + (clip.toMs - clip.fromMs) / speed
    const last = edited.at(-1)
    // Preserve quiet time up to the clip end and any hold after it by
    // re-emitting the final frame.
    if (last && last.atMs < clipEnd + holdMs) {
      edited.push({ ...last, atMs: clipEnd + holdMs })
    }
    offset = clipEnd + holdMs
  }
  return edited
}
