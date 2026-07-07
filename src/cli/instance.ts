import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { registerInstance, registryDirectory, transferInstance, unregisterInstance } from "./registry.js"
import type { InstanceManifest } from "./types.js"

export interface LaunchOptions {
  readonly name?: string
  readonly command?: ReadonlyArray<string>
  readonly dev?: string
  readonly state?: string
  readonly visible?: boolean
  readonly env?: Readonly<Record<string, string>>
}

export async function launchInstance(options: LaunchOptions = {}) {
  const name = options.name ?? "default"
  const artifacts = resolve(join(tmpdir(), "opencode-drive", `${name}-${randomSuffix()}`))
  const cwd = artifacts
  const [uiPort, backendPort] = await Promise.all([freePort(), freePort()])
  const endpoints = {
    ui: `ws://127.0.0.1:${uiPort}`,
    backend: `ws://127.0.0.1:${backendPort}`,
  }
  const manifest: InstanceManifest = {
    version: 1,
    name,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    mode: "simulated",
    headless: options.visible !== true,
    cwd,
    artifacts,
    endpoints,
  }
  await Promise.all([
    mkdir(artifacts, { recursive: true }),
    mkdir(cwd, { recursive: true }),
    mkdir(join(artifacts, "home", ".cache"), { recursive: true }),
    mkdir(join(artifacts, "home", ".config"), { recursive: true }),
    mkdir(join(artifacts, "home", ".local", "share"), { recursive: true }),
    mkdir(join(artifacts, "home", ".local", "state"), { recursive: true }),
  ])
  const state = options.state ? resolve(options.state) : join(artifacts, "state")
  if (!options.state) {
    await rm(state, { recursive: true, force: true })
    await Promise.all([
      mkdir(join(state, "files", ".git"), { recursive: true }),
      mkdir(join(state, "files", ".opencode"), { recursive: true }),
    ])
    await Bun.write(
      join(state, "files", ".opencode", "opencode.jsonc"),
      `${JSON.stringify(
        {
          model: "simulation/sim-model",
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
          providers: {
            simulation: {
              name: "Simulation",
              request: { body: { apiKey: "sim-key" } },
              models: {
                "sim-model": {
                  name: "Simulated Model",
                  api: {
                    type: "aisdk",
                    package: "@ai-sdk/openai-compatible",
                    url: "https://api.openai.com/v1",
                  },
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  limit: { context: 128000, output: 16000 },
                },
              },
            },
          },
        },
        undefined,
        2,
      )}\n`,
    )
  }
  await registerInstance(manifest)
  const environment = cleanEnv({
    ...process.env,
    ...options.env,
    DRIVE_REGISTRY_DIR: registryDirectory(),
    OPENCODE_SIMULATE: "1",
    OPENCODE_SIMULATE_STATE: state,
    OPENCODE_DRIVE: name,
    OPENCODE_DRIVE_RENDERER: options.visible ? "visible" : "headless",
    OPENCODE_CONFIG_DIR: join(cwd, ".opencode"),
    OPENCODE_DB: ":memory:",
    XDG_CACHE_HOME: join(artifacts, "home", ".cache"),
    XDG_CONFIG_HOME: join(artifacts, "home", ".config"),
    XDG_DATA_HOME: join(artifacts, "home", ".local", "share"),
    XDG_STATE_HOME: join(artifacts, "home", ".local", "state"),
  })
  const command = options.dev
    ? await prepareDev(cwd, options.dev)
    : options.command?.length
      ? [...options.command]
      : ["opencode2", "--standalone"]
  const visible = options.visible === true
  const child = Bun.spawn(command, {
    cwd,
    env: environment,
    stdin: visible ? "inherit" : "ignore",
    stdout: visible ? "inherit" : Bun.file(join(artifacts, "opencode.stdout.log")),
    stderr: visible ? "inherit" : Bun.file(join(artifacts, "opencode.stderr.log")),
  })
  const lifecycle = { detached: false, stopping: undefined as Promise<void> | undefined }
  return {
    manifest,
    child,
    async waitForDrive(requirement: "ui" | "backend" | "both" = "both", timeout = 60_000) {
      const urls = requirement === "both"
        ? [endpoints.ui, endpoints.backend]
        : [requirement === "ui" ? endpoints.ui : endpoints.backend]
      await Promise.all(urls.map((url) => waitForWebSocket(url, child.exited, timeout)))
    },
    async detach() {
      await transferInstance(manifest, child.pid)
      child.unref()
      lifecycle.detached = true
    },
    stop(force = false) {
      if (lifecycle.detached) return Promise.resolve()
      if (lifecycle.stopping) return lifecycle.stopping
      lifecycle.stopping = (async () => {
        if (force) {
          if (child.exitCode === null) child.kill("SIGKILL")
        } else if (child.exitCode === null) {
          child.kill("SIGTERM")
          await Promise.race([child.exited, Bun.sleep(1_000)])
        }
        if (child.exitCode === null) child.kill("SIGKILL")
        await child.exited
        await unregisterInstance(name, process.pid)
      })()
      return lifecycle.stopping
    },
  }
}

async function prepareDev(cwd: string, directory: string) {
  const root = resolve(directory)
  const entrypoint = join(root, "packages", "cli", "src", "index.ts")
  if (!(await Bun.file(entrypoint).exists())) throw new Error(`OpenCode development entrypoint not found: ${entrypoint}`)
  const solidPackage = join(root, "packages", "tui", "node_modules", "@opentui", "solid", "package.json")
  if (!(await Bun.file(solidPackage).exists())) {
    throw new Error(`OpenCode development dependency not found: ${solidPackage}; run bun install in ${root}`)
  }
  const info: unknown = await Bun.file(solidPackage).json()
  if (!isPackageInfo(info)) throw new Error(`Invalid @opentui/solid package metadata: ${solidPackage}`)
  await Bun.write(join(cwd, "package.json"), `${JSON.stringify({
    private: true,
    dependencies: { "@opentui/solid": info.version },
  }, undefined, 2)}\n`)
  const install = Bun.spawn([process.execPath, "install"], {
    cwd,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  const status = await install.exited
  if (status !== 0) throw new Error(`bun install failed in ${cwd} with status ${status}`)
  return [
    process.execPath,
    "--conditions=browser",
    "--preload=@opentui/solid/preload",
    entrypoint,
    "--standalone",
  ]
}

function isPackageInfo(value: unknown): value is { readonly version: string } {
  return typeof value === "object" && value !== null && "version" in value && typeof value.version === "string"
}

async function freePort() {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const port = server.port
  await server.stop(true)
  return port
}

async function waitForWebSocket(url: string, exited: Promise<number>, timeout: number) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const connected = await Promise.race([
      open(url).then((socket) => {
        socket.close()
        return true
      }).catch(() => false),
      exited.then((code) => {
        throw new Error(`OpenCode exited with status ${code} before ${url} became ready`)
      }),
    ])
    if (connected) return
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for drive endpoint ${url}`)
}

function open(url: string) {
  return new Promise<WebSocket>((resolveSocket, reject) => {
    const socket = new WebSocket(url)
    socket.addEventListener("open", () => resolveSocket(socket), { once: true })
    socket.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true })
  })
}

function randomSuffix() {
  return crypto.randomUUID().slice(0, 6)
}

function cleanEnv(env: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}
