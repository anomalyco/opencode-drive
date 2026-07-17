import { basename, resolve } from "node:path"
import type { DriveCapture, DriveManifest, Variant } from "../catalog/schema"

export interface CaptureOptions {
  readonly opencode: string
  readonly revisions: ReadonlyArray<string>
  readonly themes: ReadonlyArray<string | undefined>
}

export function parseCaptureOptions(args: ReadonlyArray<string>, defaultOpenCode: string): CaptureOptions {
  let opencode = defaultOpenCode
  const revisions: Array<string> = []
  const themes: Array<string | undefined> = []

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    const value = args[++index]
    if (!value) throw new Error(`${argument} requires a value`)
    if (argument === "--opencode") opencode = value
    else if (argument === "--revision") revisions.push(value)
    else if (argument === "--theme") themes.push(value === "default" ? undefined : value)
    else throw new Error(`Unknown capture argument: ${argument}`)
  }

  return {
    opencode: resolve(opencode),
    revisions: revisions.length === 0 ? ["HEAD"] : revisions,
    themes: themes.length === 0 ? [undefined] : themes,
  }
}

export function captureSetId(revision: string, theme: string | undefined): string {
  const suffix = theme === undefined ? "" : `-${slug(theme)}`
  return `${revision.slice(0, 12).toLowerCase()}${suffix}`
}

export function captureSetLabel(revision: string, theme: string | undefined): string {
  return `${revision.slice(0, 7)}${theme === undefined ? "" : ` / ${theme}`}`
}

export function sortCaptureSets(sets: ReadonlyArray<Variant>): Array<Variant> {
  return [...sets].sort((left, right) => {
    const byCommit = Date.parse(right.committedAt) - Date.parse(left.committedAt)
    return byCommit || left.label.localeCompare(right.label)
  })
}

export function mergeCaptureHistory(
  current: DriveManifest | undefined,
  variants: ReadonlyArray<Variant>,
  captures: ReadonlyArray<DriveCapture>,
): DriveManifest {
  const replaced = new Set(variants.map((variant) => variant.id))
  const previousVariants = current?.variants.filter((variant) => !replaced.has(variant.id)) ?? []
  const previousFrames = new Map(
    current?.captures.map((capture) => [capture.id, capture.frames.filter((frame) => !replaced.has(frame.variantId))]) ?? [],
  )

  return {
    format: "opencode-terminal-frame-captures-v1",
    generatedBy: "scripts/capture-opencode-drive.ts",
    variants: sortCaptureSets([...previousVariants, ...variants]) as [Variant, ...Array<Variant>],
    captures: captures.map((capture) => {
      const [first, ...rest] = capture.frames
      return {
        ...capture,
        frames: [first, ...rest, ...(previousFrames.get(capture.id) ?? [])] as const,
      }
    }),
  }
}

export function captureSource(path: string): string {
  return basename(resolve(path))
}

function slug(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  if (result === "") throw new Error(`Theme ${JSON.stringify(value)} cannot form a set ID`)
  return result
}
