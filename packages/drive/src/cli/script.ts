import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as OpenCodeDriver from "../driver/index.js"
import type * as OpenCodeClient from "../driver/client.js"
import * as OpenCodeUi from "../driver/ui.js"
import * as PreparedDriver from "../driver/prepared.js"
import type * as OpenCodeInstance from "../instance/runtime.js"
import { createScriptFileSystem } from "../script/filesystem.js"
import { hasGitMetadata } from "../script/project.js"
import type {
  AutomaticScriptDefinition,
  ScriptDefinition,
} from "../script/types.js"

export const loadScript = Effect.fn("DriveCli.loadScript")((file: string) =>
  Effect.tryPromise({
    try: async () => {
      const module: unknown = await import(pathToFileURL(resolve(file)).href)
      return isRecord(module) ? { default: module.default } : {}
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.flatMap((module) =>
      isScriptDefinition(module.default)
        ? Effect.succeed(module.default)
        : Effect.fail(new Error("script must default-export defineScript(...)")),
    ),
  ),
)

export const runScript = Effect.fn("DriveCli.runScript")(function* (
  script: ScriptDefinition,
  instance: OpenCodeInstance.Instance,
  onScreenshot?: (path: string) => void,
  onRecording?: (path: string) => void,
  onReady?: () => void,
) {
  const prepared = yield* PreparedDriver.make(instance, {
    visible: false,
    launch: "launch" in script ? "manual" : "automatic",
    clientName: "default",
    client: script.client,
  })
  const protectGit = yield* Effect.promise(() =>
    hasGitMetadata(join(instance.artifacts, "files")),
  )
  const operationFailure = yield* Deferred.make<never, unknown>()
  const runUi = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.tapError((cause) =>
        cause instanceof OpenCodeDriver.UiTimeoutError
          ? Deferred.fail(operationFailure, cause).pipe(Effect.asVoid)
          : Effect.void,
      ),
    )
  const recordings = new Set<string>()
  const reportRecording = (path: string) => {
    if (recordings.has(path)) return
    recordings.add(path)
    onRecording?.(path)
  }
  const adaptUi = (ui: OpenCodeUi.Ui): OpenCodeUi.Ui => {
    const transformed = OpenCodeUi.transform(ui, runUi)
    return {
      ...transformed,
      screenshot: (name) =>
        transformed.screenshot(name).pipe(
          Effect.tap((path) =>
            Effect.sync(() => onScreenshot?.(path)),
          ),
        ),
    }
  }
  const adaptClient = (client: OpenCodeClient.Client): OpenCodeClient.Client => {
    const recording = client.recording
    return {
      ui: adaptUi(client.ui),
      close: client.close,
      ...(recording === undefined
        ? {}
        : {
            recording: {
              path: recording.path,
              timeline: recording.timeline,
              finish: () =>
                runUi(recording.finish()).pipe(
                  Effect.tap((path) =>
                    Effect.sync(() => reportRecording(path)),
                  ),
                ),
            },
          }),
    }
  }
  const clientOptions = (options?: OpenCodeClient.Options) => ({
    ...script.client,
    ...options,
  })
  const clients: OpenCodeClient.Clients = {
    make: (options) =>
      prepared.clients.make(clientOptions(options)).pipe(
        Effect.tap(() => Effect.sync(() => onReady?.())),
        Effect.map(adaptClient),
      ),
    launch: (name, options) =>
      prepared.clients.launch(name, clientOptions(options)).pipe(
        Effect.tap(() => Effect.sync(() => onReady?.())),
        Effect.map(adaptClient),
      ),
  }
  const context = {
    fs: createScriptFileSystem(join(instance.artifacts, "files"), {
      git: protectGit,
    }),
    clients,
    server: {
      launch: prepared.server.launch,
      kill: prepared.server.kill,
    },
    llm: prepared.llm,
    artifacts: instance.artifacts,
  }
  const primaryClient = prepared.primary
  const automatic = (definition: AutomaticScriptDefinition) => {
    if (primaryClient === undefined || prepared.driver === undefined)
      return Effect.fail(
        new Error("automatic script did not launch its primary client"),
      )
    const client = adaptClient(primaryClient)
    return definition.run({
      ...context,
      api: prepared.driver.api,
      client,
      ui: client.ui,
    })
  }
  const execution =
    "launch" in script
      ? script.run({ ...context, ui: null })
      : automatic(script)
  if (!Effect.isEffect(execution))
    return yield* Effect.fail(new Error("script run must return an Effect"))
  if (primaryClient !== undefined) onReady?.()
  yield* Effect.raceAllFirst([
    execution,
    Deferred.await(operationFailure),
    prepared.failure.pipe(
      Effect.catchIf(isZeroStatusClientExit, () => Effect.void),
    ),
  ])
  const report = yield* prepared.settle()
  for (const path of report.recordings) reportRecording(path)
  return undefined
})

function isZeroStatusClientExit(cause: unknown) {
  return (
    cause instanceof OpenCodeDriver.OpenCodeDriverError &&
    cause.operation === "client.exit" &&
    cause.message.endsWith("status 0")
  )
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isScriptDefinition(value: unknown): value is ScriptDefinition {
  if (!isRecord(value)) return false
  return (
    value.kind === "opencode-drive/script" &&
    typeof value.run === "function" &&
    (value.project === undefined || isScriptProject(value.project)) &&
    (value.config === undefined || isJsonObject(value.config)) &&
    (value.tui === undefined || isJsonObject(value.tui)) &&
    (value.setup === undefined || typeof value.setup === "function") &&
    (value.tools === undefined || typeof value.tools === "function") &&
    (value.client === undefined || isClientOptions(value.client)) &&
    (!("launch" in value) || value.launch === "manual")
  )
}

function isClientOptions(value: unknown) {
  if (!isRecord(value)) return false
  if (value.recording !== undefined && typeof value.recording !== "boolean")
    return false
  if (value.viewport === undefined) return true
  if (!isRecord(value.viewport)) return false
  return (
    typeof value.viewport.cols === "number" &&
    Number.isFinite(value.viewport.cols) &&
    typeof value.viewport.rows === "number" &&
    Number.isFinite(value.viewport.rows)
  )
}

function isJsonObject(value: unknown) {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isScriptProject(value: unknown) {
  if (!isRecord(value)) return false
  if (value.git !== undefined && typeof value.git !== "boolean") return false
  if (value.files === undefined) return true
  if (!isRecord(value.files)) return false
  const prototype = Object.getPrototypeOf(value.files)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(value.files).every(
    (contents) => typeof contents === "string" || contents instanceof Uint8Array,
  )
}
