import { homedir } from "node:os"
import { basename, join } from "node:path"
import { mkdir, open, readdir, rename, rm } from "node:fs/promises"
import type { InstanceManifest } from "./types.js"

export function registryDirectory() {
  if (process.env.DRIVE_REGISTRY_DIR) return process.env.DRIVE_REGISTRY_DIR
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode-drive", "instances")
}

export function manifestPath(name: string) {
  return join(registryDirectory(), `${validateName(name)}.json`)
}

export async function registerInstance(manifest: InstanceManifest) {
  await mkdir(registryDirectory(), { recursive: true })
  const file = manifestPath(manifest.name)
  const lock = `${file}.lock`
  const existing = await readManifest(file)
  if (existing && processAlive(existing.pid)) throw new Error(`drive instance "${manifest.name}" is already running`)
  if (existing) await rm(file, { force: true })
  const handle = await open(lock, "wx").catch(() => undefined)
  if (!handle) throw new Error(`drive instance "${manifest.name}" is already starting`)
  try {
    const current = await readManifest(file)
    if (current && processAlive(current.pid)) throw new Error(`drive instance "${manifest.name}" is already running`)
    const temporary = `${file}.${process.pid}.tmp`
    await Bun.write(temporary, `${JSON.stringify(manifest, undefined, 2)}\n`)
    await rename(temporary, file)
    return file
  } finally {
    await handle.close()
    await rm(lock, { force: true })
  }
}

export async function unregisterInstance(name: string, pid: number) {
  const file = manifestPath(name)
  const manifest = await readManifest(file)
  if (manifest?.pid !== pid) return
  await rm(file, { force: true })
}

export async function transferInstance(manifest: InstanceManifest, pid: number) {
  const file = manifestPath(manifest.name)
  const current = await readManifest(file)
  if (current?.pid !== manifest.pid) throw new Error(`drive instance "${manifest.name}" changed ownership`)
  const temporary = `${file}.${process.pid}.tmp`
  await Bun.write(temporary, `${JSON.stringify({ ...manifest, pid }, undefined, 2)}\n`)
  await rename(temporary, file)
}

export async function resolveInstance(name?: string) {
  const instances = await listInstances()
  if (name) {
    const instance = instances.find((item) => item.name === name)
    if (!instance) throw new Error(`drive instance "${name}" was not found`)
    return instance
  }
  if (instances.length === 1) return instances[0]!
  if (instances.length === 0) throw new Error("no drive instances are running")
  throw new Error(`multiple drive instances are running; pass --name (${instances.map((item) => item.name).join(", ")})`)
}

export async function listInstances() {
  await mkdir(registryDirectory(), { recursive: true })
  const directory = registryDirectory()
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json"))
  const entries = await Promise.all(files.map((file) => readManifest(join(directory, file))))
  const active = entries.filter((entry): entry is InstanceManifest => entry !== undefined && processAlive(entry.pid))
  const activeNames = new Set(active.map((entry) => entry.name))
  await Promise.all(
    files
      .filter((file) => !activeNames.has(basename(file, ".json")))
      .map((file) => rm(join(directory, file), { force: true })),
  )
  return active.sort((a, b) => a.name.localeCompare(b.name))
}

async function readManifest(file: string): Promise<InstanceManifest | undefined> {
  if (!(await Bun.file(file).exists())) return undefined
  try {
    const value = await Bun.file(file).json()
    if (!isManifest(value)) return undefined
    return value
  } catch {
    await rm(file, { force: true })
    return undefined
  }
}

function isManifest(value: unknown): value is InstanceManifest {
  if (typeof value !== "object" || value === null) return false
  if (!("version" in value) || value.version !== 1) return false
  if (!("name" in value) || typeof value.name !== "string") return false
  if (!("pid" in value) || typeof value.pid !== "number") return false
  if (!("startedAt" in value) || typeof value.startedAt !== "string") return false
  if (!("mode" in value) || (value.mode !== "simulated" && value.mode !== "real")) return false
  if (!("cwd" in value) || typeof value.cwd !== "string") return false
  if (!("artifacts" in value) || typeof value.artifacts !== "string") return false
  if (!("endpoints" in value) || typeof value.endpoints !== "object" || value.endpoints === null) return false
  return "ui" in value.endpoints && typeof value.endpoints.ui === "string" && "backend" in value.endpoints && typeof value.endpoints.backend === "string"
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function validateName(name: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
    throw new Error("instance names must contain 1-64 letters, numbers, dots, underscores, or dashes")
  }
  return name
}
