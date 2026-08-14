import { basename, join, resolve } from "node:path"
import { readdir, stat } from "node:fs/promises"
import { artifactDirectory } from "./instance.js"

export function mediaDirectory() {
  return resolve(
    process.env.OPENCODE_DRIVE_MEDIA_DIR ??
      join(artifactDirectory(), "output"),
  )
}

export const runMediaDirectory = (artifacts: string, generation: number) =>
  join(
    mediaDirectory(),
    basename(resolve(artifacts)),
    `generation-${generation}`,
  )

export async function readInstanceMediaDirectory(artifacts: string, endpoint: string) {
  const directory = join(artifacts, "drive")
  const manifests = await Promise.all(
    (await readdir(directory)).filter((name) => name.endsWith(".json")).map(async (name) => {
      const path = join(directory, name)
      const [value, metadata]: [unknown, Awaited<ReturnType<typeof stat>>] = await Promise.all([
        Bun.file(path).json(),
        stat(path),
      ])
      if (
        typeof value !== "object" ||
        value === null ||
        !("endpoints" in value) ||
        typeof value.endpoints !== "object" ||
        value.endpoints === null ||
        !("ui" in value.endpoints) ||
        value.endpoints.ui !== endpoint ||
        !("media" in value) ||
        typeof value.media !== "string"
      )
        return undefined
      return { media: value.media, modified: metadata.mtimeMs }
    }),
  )
  const current = manifests.filter((manifest) => manifest !== undefined).sort((a, b) => b.modified - a.modified)[0]
  if (!current) throw new Error(`drive endpoint "${endpoint}" has no media directory`)
  return current.media
}
