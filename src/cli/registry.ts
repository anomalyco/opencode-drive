import { mkdir, open, readdir, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"

export interface InstanceManifest {
  readonly version: 1
  readonly name: string
  readonly pid: number
  readonly startedAt: string
  readonly cwd: string
  readonly artifacts: string
  readonly visible: boolean
  readonly status: "starting" | "ready"
  readonly endpoints: { readonly ui: string; readonly backend: string }
  readonly control: string
}

export interface InitializedManifest {
  readonly version: 1
  readonly name: string
  readonly createdAt: string
  readonly cwd: string
  readonly artifacts: string
  readonly status: "initialized"
}

export type Manifest = InstanceManifest | InitializedManifest

export function registryDirectory() {
  return (
    process.env.DRIVE_REGISTRY_DIR ??
    join(
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      "opencode-drive",
      "instances",
    )
  )
}

export function manifestPath(name: string) {
  return join(registryDirectory(), `${validateName(name)}.json`)
}

export function controlPath(name: string) {
  return join(registryDirectory(), `${validateName(name)}.sock`)
}

export async function initializeManifest(name: string, cwd: string, create: () => Promise<string>) {
  let initialized: InitializedManifest | undefined
  await withLock(name, false, async () => {
    const existing = await read(manifestPath(name))
    if (existing?.status === "initialized") {
      initialized = existing
      return
    }
    if (existing && alive(existing.pid))
      throw new Error(`drive instance "${name}" is already running`)
    initialized = {
      version: 1,
      name,
      createdAt: new Date().toISOString(),
      cwd,
      artifacts: await create(),
      status: "initialized",
    }
    await Promise.all([
      rm(manifestPath(name), { force: true }),
      rm(controlPath(name), { force: true }),
    ])
    await write(initialized)
  })
  if (!initialized) throw new Error(`failed to initialize drive instance "${name}"`)
  return initialized
}

export async function register(manifest: InstanceManifest) {
  await withLock(manifest.name, false, async () => {
    const existing = await read(manifestPath(manifest.name))
    if (existing && existing.status !== "initialized" && alive(existing.pid))
      throw new Error(`drive instance "${manifest.name}" is already running`)
    await Promise.all([
      rm(manifestPath(manifest.name), { force: true }),
      rm(controlPath(manifest.name), { force: true }),
    ])
    await write(manifest)
  })
}

export async function markReady(name: string, pid: number) {
  await markStatus(name, pid, "ready")
}

export async function markStarting(name: string, pid: number) {
  await markStatus(name, pid, "starting")
}

async function markStatus(name: string, pid: number, status: InstanceManifest["status"]) {
  await withLock(name, true, async () => {
    const manifest = await read(manifestPath(name))
    if (!manifest || manifest.status === "initialized" || manifest.pid !== pid)
      throw new Error(`drive instance "${name}" changed ownership`)
    await write({ ...manifest, status })
  })
}

export async function resolveInstance(name?: string, options: { readonly ready?: boolean } = {}) {
  const instances = await listInstances()
  const manifest = name
    ? instances.find((item) => item.name === name)
    : instances.length === 1
      ? instances[0]
      : undefined
  if (!manifest) {
    if (!name && instances.length > 1)
      throw new Error(
        `multiple drive instances are running; pass --name (${instances.map((item) => item.name).join(", ")})`,
      )
    throw new Error(
      name ? `drive instance "${name}" was not found` : "no drive instances are running",
    )
  }
  if (options.ready !== false && manifest.status !== "ready")
    throw new Error(`drive instance "${manifest.name}" is still starting`)
  return manifest
}

export async function listInstances() {
  return (await listManifests()).filter(
    (manifest): manifest is InstanceManifest => manifest.status !== "initialized",
  )
}

export async function listManifests() {
  await mkdir(registryDirectory(), { recursive: true })
  const files = await readdir(registryDirectory())
  const manifests = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        const name = basename(file, ".json")
        if (!validName(name)) {
          await rm(join(registryDirectory(), file), { force: true })
          return undefined
        }
        const manifest = await read(join(registryDirectory(), file))
        if (manifest?.name === name) {
          if (manifest.status === "initialized" || alive(manifest.pid)) return manifest
        }
        await prune(name, manifest?.status === "initialized" ? undefined : manifest?.pid)
        return undefined
      }),
  )
  const active = manifests.filter((manifest): manifest is Manifest => manifest !== undefined)
  const names = new Set(active.map((manifest) => manifest.name))
  await Promise.all(
    files
      .filter((file) => file.endsWith(".sock"))
      .flatMap((file) => {
        const name = basename(file, ".sock")
        if (!validName(name)) return [rm(join(registryDirectory(), file), { force: true })]
        if (!names.has(name)) return [prune(name)]
        return []
      }),
  )
  return active.sort((a, b) => a.name.localeCompare(b.name))
}

export async function unregister(name: string, pid: number) {
  await withLock(name, true, async () => {
    const manifest = await read(manifestPath(name))
    if (!manifest || manifest.status === "initialized" || manifest.pid !== pid) return
    await Promise.all([
      rm(manifestPath(name), { force: true }),
      rm(controlPath(name), { force: true }),
    ])
  })
}

async function prune(name: string, pid?: number) {
  await withLock(name, true, async () => {
    const manifest = await read(manifestPath(name))
    if (manifest?.status === "initialized") return
    if (manifest && (manifest.pid !== pid || alive(manifest.pid))) return
    await Promise.all([
      rm(manifestPath(name), { force: true }),
      rm(controlPath(name), { force: true }),
    ])
  })
}

async function write(manifest: Manifest) {
  const file = manifestPath(manifest.name)
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await Bun.write(temporary, `${JSON.stringify(manifest, undefined, 2)}\n`)
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function read(file: string): Promise<Manifest | undefined> {
  const value: unknown = await Bun.file(file)
    .json()
    .catch(() => undefined)
  if (isManifest(value)) return value
  return undefined
}

async function withLock(name: string, wait: boolean, task: () => Promise<void>) {
  await mkdir(registryDirectory(), { recursive: true })
  const lock = `${manifestPath(name)}.lock`
  const deadline = Date.now() + 10_000
  while (true) {
    const handle = await open(lock, "wx").catch((error: unknown) => {
      if (isNodeError(error) && error.code === "EEXIST") return undefined
      throw error
    })
    if (handle) {
      try {
        await handle.writeFile(`${process.pid}\n`)
        await task()
        return
      } finally {
        await handle.close()
        await rm(lock, { force: true })
      }
    }
    if (await staleLock(lock)) {
      await rm(lock, { force: true })
      continue
    }
    if (!wait) throw new Error(`drive instance "${name}" is already starting`)
    if (Date.now() >= deadline) throw new Error(`timed out updating drive instance "${name}"`)
    await Bun.sleep(10)
  }
}

async function staleLock(file: string) {
  const pid = Number.parseInt(
    await Bun.file(file)
      .text()
      .catch(() => ""),
    10,
  )
  return Number.isInteger(pid) && !alive(pid)
}

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== "object" || value === null) return false
  if (!("version" in value) || value.version !== 1) return false
  if (!("name" in value) || typeof value.name !== "string") return false
  if ("status" in value && value.status === "initialized")
    return (
      "createdAt" in value &&
      typeof value.createdAt === "string" &&
      "cwd" in value &&
      typeof value.cwd === "string" &&
      "artifacts" in value &&
      typeof value.artifacts === "string"
    )
  if (!("pid" in value) || typeof value.pid !== "number") return false
  if (!("startedAt" in value) || typeof value.startedAt !== "string") return false
  if (!("cwd" in value) || typeof value.cwd !== "string") return false
  if (!("artifacts" in value) || typeof value.artifacts !== "string") return false
  if (!("visible" in value) || typeof value.visible !== "boolean") return false
  if (!("status" in value) || (value.status !== "starting" && value.status !== "ready"))
    return false
  if (!("control" in value) || typeof value.control !== "string") return false
  if (!("endpoints" in value) || typeof value.endpoints !== "object" || value.endpoints === null)
    return false
  return (
    "ui" in value.endpoints &&
    typeof value.endpoints.ui === "string" &&
    "backend" in value.endpoints &&
    typeof value.endpoints.backend === "string"
  )
}

function validateName(name: string) {
  if (!validName(name))
    throw new Error(
      "instance names must contain 1-64 letters, numbers, dots, underscores, or dashes",
    )
  return name
}

function validName(name: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
