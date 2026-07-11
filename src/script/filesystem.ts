import { lstat, mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import type { ScriptFileSystem } from "./types.js"

export function createScriptFileSystem(
  directory: string,
  options: { readonly git?: boolean } = {},
): ScriptFileSystem {
  const root = resolve(directory)
  return {
    async writeFile(path, contents) {
      if (isAbsolute(path)) throw new Error("fs.writeFile path must be relative")
      const destination = resolve(root, path)
      const resolved = relative(root, destination)
      if (resolved === ".." || resolved.startsWith(`..${sep}`))
        throw new Error("fs.writeFile path must stay inside the simulated project")
      if (options.git && resolved.split(sep)[0] === ".git")
        throw new Error("fs.writeFile path must not modify Git metadata")
      await rejectSymlinks(root, destination)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, contents)
    },
  }
}

async function rejectSymlinks(root: string, destination: string) {
  const parts = relative(root, destination).split(sep)
  let current = root
  for (const part of parts) {
    current = resolve(current, part)
    const stats = await lstat(current).catch((error: unknown) => {
      if (isMissing(error)) return undefined
      throw error
    })
    if (stats === undefined) return
    if (stats.isSymbolicLink())
      throw new Error("fs.writeFile path must not contain symbolic links")
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  )
}
