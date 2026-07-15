import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as OpenCodeDriver from "../driver/index.js"
import type * as OpenCodeClient from "../driver/client.js"
import * as PreparedDriver from "../driver/prepared.js"
import type * as OpenCodeInstance from "../instance/runtime.js"
import * as Llm from "../llm/index.js"
import { createScriptFileSystem } from "../script/filesystem.js"
import { hasGitMetadata } from "../script/project.js"
import type {
  LlmOutput,
  LlmResponse,
  ScriptClientOptions,
  ScriptDefinition,
  ScriptLlm,
  ScriptUi,
  UiElementQuery,
  UiMatcher,
  UiPredicate,
  UiWaitOptions,
} from "../script/types.js"

export async function loadScript(file: string): Promise<ScriptDefinition> {
  const module: { readonly default?: unknown } = await import(
    pathToFileURL(resolve(file)).href
  )
  if (!isScriptDefinition(module.default))
    throw new Error("script must default-export defineScript({ project?, setup?, run })")
  return module.default
}

export const runScript = Effect.fn("DriveCli.runScript")(function* (
  script: ScriptDefinition,
  instance: OpenCodeInstance.Instance,
  signal: AbortSignal,
  onScreenshot?: (path: string) => void,
  onRecording?: (path: string) => void,
  onReady?: () => void,
) {
  const prepared = yield* PreparedDriver.make(instance, {
    visible: false,
    launch: "launch" in script ? "manual" : "automatic",
    clientName: "default",
    client: { viewport: script.viewport },
  })
  const localAbort = new AbortController()
  const scriptSignal = AbortSignal.any([signal, localAbort.signal])
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => localAbort.abort(new Error("script finished"))),
  )
  const protectGit = yield* Effect.promise(() =>
    hasGitMetadata(join(instance.artifacts, "files")),
  )
  const operationFailure = Promise.withResolvers<never>()
  void operationFailure.promise.catch(() => undefined)
  const recordings = new Set<string>()
  const reportRecording = (path: string) => {
    if (recordings.has(path)) return
    recordings.add(path)
    onRecording?.(path)
  }
  const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
    const promise = Effect.runPromise(effect, { signal: scriptSignal })
    void promise.catch((cause) => {
      if (isTimeoutError(cause)) {
        if (!localAbort.signal.aborted) localAbort.abort(cause)
        operationFailure.reject(cause)
      }
    })
    return promise
  }
  const runBackground = <A, E>(effect: Effect.Effect<A, E>) => {
    const promise = run(effect)
    void promise.catch((cause) => operationFailure.reject(cause))
    return promise
  }
  const adaptUi = (client: OpenCodeClient.Client): ScriptUi => {
    const ui = client.ui
    const call = <A, E>(effect: Effect.Effect<A, E>) => run(effect)
    return {
      async kill() {
        const output = client.recording === undefined
          ? undefined
          : await call(client.recording.finish())
        if (output !== undefined) reportRecording(output)
        await call(client.close())
        return output
      },
      state: () => call(ui.state()),
      matches: (matcher) => call(ui.matches(matcher)),
      async screenshot(name) {
        const path = await call(ui.screenshot(name))
        onScreenshot?.(path)
        return path
      },
      type: (text) => call(ui.type(text)),
      press: (key, modifiers) => call(ui.press(key, modifiers)),
      enter: () => call(ui.enter()),
      arrow: (direction) => call(ui.arrow(direction)),
      focus: (target) => call(ui.focus(target)),
      click: (target, position) => call(ui.click(target, position)),
      resize: (viewport) => call(ui.resize(viewport)),
      submit: (text) => call(ui.submit(text)),
      waitFor(target: UiMatcher | UiPredicate, options?: UiWaitOptions) {
        return call(
          typeof target === "string"
            ? ui.waitFor(target, options)
            : ui.waitForEffect(
                (state) =>
                  Effect.tryPromise({
                    try: () => Promise.resolve(target(state)),
                    catch: (cause) =>
                      cause instanceof Error ? cause : new Error(String(cause)),
                  }),
                options,
              ),
        )
      },
      getElement: (
        target: number | string | UiElementQuery,
        options?: UiWaitOptions,
      ) => call(ui.getElement(target, options)),
    }
  }
  const llm = adaptLlm(prepared.llm, run, runBackground)
  const clients = {
    launch: (name: string, options?: ScriptClientOptions) =>
      run(
        prepared.clients.launch(name, {
          recording: options?.record,
          viewport: options?.viewport ?? script.viewport,
        }),
      ).then((client) => {
        onReady?.()
        return adaptUi(client)
      }),
  }
  const context = {
    fs: createScriptFileSystem(join(instance.artifacts, "files"), {
      git: protectGit,
    }),
    clients,
    server: {
      launch: () => run(prepared.server.launch()),
      kill: () => run(prepared.server.kill()),
    },
    llm,
    artifacts: instance.artifacts,
    signal: scriptSignal,
  }
  const primaryClient = prepared.primary
  const execution = Promise.resolve(
    "launch" in script
      ? script.run({ ...context, ui: null })
      : script.run({ ...context, ui: adaptUi(primaryClient!) }),
  )
  if (primaryClient !== undefined) onReady?.()
  yield* Effect.tryPromise({
    try: async () => {
      try {
        await Promise.race([
          execution,
          operationFailure.promise,
          Effect.runPromise(prepared.failure),
          aborted(scriptSignal),
        ])
      } catch (cause) {
        if (isZeroStatusClientExit(cause)) {
          localAbort.abort(cause)
          await execution
          return
        }
        throw cause
      }
    },
    catch: (cause) => cause,
  })
  const settlement = yield* prepared.settle()
  for (const path of settlement.recordings) reportRecording(path)
})

function adaptLlm(
  controller: OpenCodeDriver.Llm,
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
  runBackground: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
): ScriptLlm {
  return {
    queue(...output) {
      void runBackground(controller.queue(...output.map(normalizeOutput)))
    },
    send: (...output) => run(controller.send(...output.map(normalizeOutput))),
    serve(handler) {
      void runBackground(
        controller.serve((request, index) =>
          responseStream(() => handler(request, index)),
        ),
      )
    },
    title(handler) {
      void runBackground(
        controller.title((request, index) =>
          Effect.tryPromise({
            try: () => Promise.resolve(handler(request, index)),
            catch: (cause) => cause,
          }).pipe(
            Effect.mapError((cause) =>
              new OpenCodeDriver.LlmControllerError({
                operation: "title",
                requestId: request.id,
                message: cause instanceof Error ? cause.message : String(cause),
              }),
            ),
          ),
        ),
      )
    },
    text: Llm.text,
    reasoning: Llm.reasoning,
    pause: Llm.pause,
    toolCall: Llm.toolCall,
    raw: Llm.raw,
    finish: Llm.finish,
    disconnect: Llm.disconnect,
  }
}

function responseStream(make: () => LlmResponse) {
  const iterable = {
    async *[Symbol.asyncIterator]() {
      for await (const item of make()) yield normalizeOutput(item)
    },
  }
  return Stream.fromAsyncIterable(iterable, (cause) =>
    new OpenCodeDriver.LlmControllerError({
      operation: "serve",
      message: cause instanceof Error ? cause.message : String(cause),
    }),
  )
}

function normalizeOutput(output: LlmOutput): Llm.Output {
  if (output.type === "textDelta" || output.type === "reasoningDelta")
    return Llm.raw({ type: output.type, text: output.text })
  return output
}

function aborted(signal: AbortSignal) {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("script aborted"))
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new Error("script aborted")),
      { once: true },
    )
  })
}

function isZeroStatusClientExit(cause: unknown) {
  return (
    cause instanceof OpenCodeDriver.OpenCodeDriverError &&
    cause.operation === "client.exit" &&
    cause.message.endsWith("status 0")
  )
}

function isTimeoutError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /\btimeout\b|\btimed out\b/i.test(message)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isScriptDefinition(value: unknown): value is ScriptDefinition {
  if (!isRecord(value)) return false
  return (
    typeof value.run === "function" &&
    (value.project === undefined || isScriptProject(value.project)) &&
    (value.config === undefined || isJsonObject(value.config)) &&
    (value.tui === undefined || isJsonObject(value.tui)) &&
    (value.setup === undefined || typeof value.setup === "function") &&
    (value.tools === undefined || typeof value.tools === "function") &&
    (!("launch" in value) || value.launch === "manual")
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
