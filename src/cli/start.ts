import { launchInstance } from "./instance.js"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { connectMockBackend } from "./mock-backend.js"
import { createResponseSettings } from "./response-generator.js"
import { runScript } from "./script.js"
import { listenControl } from "./control.js"
import {
  controlPath,
  markReady,
  markStarting,
  register,
  registryDirectory,
  resolveInstance,
  unregister,
} from "./registry.js"
import type { StartOptions } from "./types.js"

export async function start(options: StartOptions) {
  if (!options.visible && !options.script && !options.daemon)
    return startDetached(options)
  const responses = createResponseSettings()
  const instance = await launchInstance({
    name: options.name,
    command: options.command,
    dev: options.dev,
    state: options.state,
    scripted: options.script !== undefined,
    visible: options.visible,
  })
  await register({
    version: 1,
    name: options.name,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    artifacts: instance.artifacts,
    visible: options.visible,
    status: "starting",
    endpoints: instance.endpoints,
    control: controlPath(options.name),
  }).catch(async (error) => {
    await instance.stop()
    throw error
  })
  const interrupt = () => void instance.stop()
  let completed = false
  let current: ReturnType<typeof run> | undefined
  let restarting: Promise<void> | undefined
  let stopping = false
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  let closeControl: (() => Promise<void>) | undefined
  try {
    closeControl = await listenControl(controlPath(options.name), {
      restart: () => {
        if (restarting) return restarting
        restarting = (async () => {
          await markStarting(options.name, process.pid)
          const previous = current
          previous?.abort.abort(new Error("script restarted"))
          await previous?.promise.catch(() => undefined)
          await instance.restart()
          current = run(options, instance, responses)
          await current.ready
          await markReady(options.name, process.pid)
        })().finally(() => {
          restarting = undefined
        })
        return restarting
      },
      stop: async () => {
        stopping = true
        current?.abort.abort(new Error("opencode-drive stopped"))
        await instance.stop()
      },
      responses: async (input) => {
        if (options.script)
          throw new Error("responses are unavailable when --script owns the simulation backend")
        return responses.update(input)
      },
    })
    current = run(options, instance, responses)
    await current.ready
    await markReady(options.name, process.pid)
    if (options.visible) {
      const status = await instance.wait()
      if (status !== 0 && !stopping) process.exitCode = status
      return
    }
    while (true) {
      const active: NonNullable<typeof current> = current
      await active.promise
      if (stopping) break
      if (restarting) {
        await restarting
        continue
      }
      if (active !== current) continue
      completed = true
      break
    }
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
    current?.abort.abort(new Error("opencode-drive stopped"))
    await closeControl?.()
    await instance.stop()
    await unregister(options.name, process.pid)
    if (options.script && !options.visible)
      report(instance, completed ? "completed" : undefined)
  }
}

async function startDetached(options: StartOptions) {
  const existing = await resolveInstance(options.name, { ready: false }).catch(() => undefined)
  if (existing)
    throw new Error(`drive instance "${options.name}" is already running`)
  const ownerLog = join(registryDirectory(), `${options.name}.log`)
  await mkdir(registryDirectory(), { recursive: true })
  await rm(ownerLog, { force: true })
  const child = Bun.spawn(
    [
      process.execPath,
      process.argv[1]!,
      "start",
      "--daemon",
      "--name",
      options.name,
      ...(options.script ? ["--script", options.script] : []),
      ...(options.dev ? ["--dev", options.dev] : []),
      ...(options.state ? ["--state", options.state] : []),
      ...(options.command.length ? ["--", ...options.command] : []),
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: Bun.file(ownerLog),
    },
  )
  child.unref()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const manifest = await resolveInstance(options.name).catch(() => undefined)
    if (manifest?.pid === child.pid) {
      report({
        artifacts: manifest.artifacts,
        logs: `${manifest.artifacts}/logs`,
      })
      return
    }
    if (child.exitCode !== null)
      throw new Error(
        `detached instance exited with status ${child.exitCode}; see ${ownerLog}`,
      )
    await Bun.sleep(50)
  }
  await terminateOwner(child)
  throw new Error(
    `timed out starting drive instance "${options.name}"; see ${ownerLog}`,
  )
}

async function terminateOwner(child: Bun.Subprocess) {
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  const deadline = Date.now() + 1_000
  while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(25)
  if (child.exitCode === null) child.kill("SIGKILL")
  await child.exited
}

function run(
  options: StartOptions,
  instance: Awaited<ReturnType<typeof launchInstance>>,
  responses: ReturnType<typeof createResponseSettings>,
) {
  const abort = new AbortController()
  const child = instance.child
  let ready!: () => void
  const readiness = new Promise<void>((resolve) => {
    ready = resolve
  })
  return {
    abort,
    ready: readiness,
    promise: (async () => {
      await instance.waitForDrive("both")
      if (options.script) {
        const script = runScript(
          options.script,
          instance.artifacts,
          instance.endpoints,
          abort.signal,
        )
        ready()
        await script
        if (options.visible) {
          await Promise.race([
            child.exited,
            new Promise<void>((resolve) =>
              abort.signal.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            ),
          ])
        }
        return
      }
      const mock = await connectMockBackend(instance.endpoints.backend, responses)
      ready()
      abort.signal.addEventListener("abort", () => mock.close(), { once: true })
      const status = await Promise.race([
        child.exited,
        new Promise<number>((resolve) =>
          abort.signal.addEventListener("abort", () => resolve(0), {
            once: true,
          }),
        ),
      ])
      mock.close()
      if (status !== 0 && !abort.signal.aborted) process.exitCode = status
    })(),
  }
}

function report(
  instance: { readonly artifacts: string; readonly logs: string },
  status?: string,
) {
  if (status) console.error(`opencode-drive: ${status}`)
  console.error(`opencode-drive: artifacts ${instance.artifacts}`)
}
