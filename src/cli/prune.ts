import { readdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { artifactDirectory } from "../instance/instance.js"
import { listManifests } from "../instance/registry.js"

export async function prune() {
  const directory = artifactDirectory()
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return []
    throw error
  })
  const active = new Set((await listManifests()).map((manifest) => resolve(manifest.artifacts)))
  const stale = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
    .map((entry) => join(directory, entry.name))
    .filter((artifacts) => !active.has(resolve(artifacts)))

  await Promise.all(stale.map((artifacts) => rm(artifacts, { recursive: true, force: true })))
  console.log(stale.length)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
