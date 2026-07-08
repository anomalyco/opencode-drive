import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

export function mediaDirectory() {
  return resolve(
    process.env.OPENCODE_DRIVE_MEDIA_DIR ??
      join(tmpdir(), "opencode-drive", "output"),
  )
}

export async function ensureMediaDirectory() {
  const directory = mediaDirectory()
  await mkdir(directory, { recursive: true })
  return directory
}
