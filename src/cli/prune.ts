import { readdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { artifactDirectory } from "../instance/instance.js"
import { listManifests } from "../instance/registry.js"

export async function prune(options: { readonly name?: string; readonly force?: boolean } = {}) {
  if (options.name !== undefined && !/^run-[^/\\]+$/.test(options.name))
    throw new Error(`invalid artifact directory name: ${options.name}`)
  const directory = artifactDirectory()
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return []
    throw error
  })
  const active = new Set((await listManifests()).map((manifest) => resolve(manifest.artifacts)))
  const pruned = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
    .filter((entry) => options.name === undefined || entry.name === options.name)
    .map((entry) => join(directory, entry.name))
    .filter((artifacts) => options.force || !active.has(resolve(artifacts)))

  await Promise.all(pruned.map((artifacts) => rm(artifacts, { recursive: true, force: true })))
  console.log(pruned.length)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
