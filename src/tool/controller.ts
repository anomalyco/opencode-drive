import { fileURLToPath } from "node:url"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { JsonValue, OpenCodeConfig, ScriptSetup } from "../script/types.js"
import {
  Failure,
  ShellInput,
  ShellResult,
  WebFetchInput,
  WebFetchResult,
  WebSearchInput,
  WebSearchResult,
  type Registration,
  type Registry,
  type Setup,
  type ShellHandler,
  type WebFetchHandler,
  type WebSearchHandler,
} from "./types.js"

type Result = ShellResult | WebFetchResult | WebSearchResult
type Event =
  | { readonly type: "progress"; readonly result: Result }
  | { readonly type: "success"; readonly result: Result }
  | { readonly type: "failure"; readonly message: string }
type Definition = {
  readonly schema: typeof ShellInput | typeof WebFetchInput | typeof WebSearchInput
  readonly invoke: (
    input: unknown,
    index: number,
    signal: AbortSignal,
    progress: (result: Result) => Effect.Effect<void>,
  ) => Effect.Effect<Result, unknown>
}

const MAX_EVENT_BYTES = 1024 * 1024

export interface Controller {
  readonly configure: (config: OpenCodeConfig) => void
}

export function composeSetup(
  controller: Controller,
  tools: Setup | undefined,
  setup: ScriptSetup | undefined,
): ScriptSetup | undefined {
  if (tools === undefined && setup === undefined) return undefined
  return async (context) => {
    await setup?.(context)
    controller.configure(context.config)
  }
}

export const make = Effect.fn("ToolController.make")(function* (setup?: Setup) {
  const definitions = new Map<string, Definition>()
  const add = (name: string, definition: Definition) => {
    if (definitions.has(name)) throw new Error(`tool handler already registered: ${name}`)
    definitions.set(name, definition)
  }
  function handle(name: "shell", handler: ShellHandler): void
  function handle(name: "webfetch", handler: WebFetchHandler): void
  function handle(name: "websearch", handler: WebSearchHandler): void
  function handle(...registration: Registration) {
      switch (registration[0]) {
        case "shell": {
          const handler = registration[1]
          add("shell", {
            schema: ShellInput,
            invoke: (raw, index, signal, progress) =>
              Effect.gen(function* () {
                const input = yield* Schema.decodeUnknownEffect(ShellInput)(raw)
                const result = yield* handler({
                  input,
                  index,
                  signal,
                  progress: (value) => progress(typeof value === "string" ? { output: value } : value),
                })
                return yield* Schema.decodeUnknownEffect(ShellResult)(result)
              }),
          })
          return
        }
        case "webfetch": {
          const handler = registration[1]
          add("webfetch", {
            schema: WebFetchInput,
            invoke: (raw, index, signal, progress) =>
              Effect.gen(function* () {
                const input = yield* Schema.decodeUnknownEffect(WebFetchInput)(raw)
                const result = yield* handler({
                  input,
                  index,
                  signal,
                  progress: (value) => progress(typeof value === "string" ? { output: value } : value),
                })
                return yield* Schema.decodeUnknownEffect(WebFetchResult)(result)
              }),
          })
          return
        }
        case "websearch": {
          const handler = registration[1]
          add("websearch", {
            schema: WebSearchInput,
            invoke: (raw, index, signal, progress) =>
              Effect.gen(function* () {
                const input = yield* Schema.decodeUnknownEffect(WebSearchInput)(raw)
                const result = yield* handler({
                  input,
                  index,
                  signal,
                  progress: (value) => progress(typeof value === "string" ? { output: value } : value),
                })
                return yield* Schema.decodeUnknownEffect(WebSearchResult)(result)
              }),
          })
        }
      }
  }
  const registry: Registry = { handle }
  setup?.(registry)
  if (definitions.size === 0) return { configure() {} } satisfies Controller

  const token = crypto.randomUUID()
  const indexes = new Map<string, number>()
  const active = new Set<AbortController>()
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 255,
        fetch(request) {
          if (request.headers.get("authorization") !== `Bearer ${token}`)
            return new Response("Unauthorized", { status: 401 })
          const name = new URL(request.url).pathname.match(/^\/execute\/([^/]+)$/)?.[1]
          const definition = name === undefined ? undefined : definitions.get(name)
          if (request.method !== "POST" || name === undefined)
            return new Response("Not found", { status: 404 })
          if (definition === undefined)
            return new Response("Tool handler not registered", { status: 404 })
          const index = indexes.get(name) ?? 0
          indexes.set(name, index + 1)
          return execute(request, definition, index, active)
        },
      }),
    ),
    (server) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          for (const controller of active)
            controller.abort(new Error("Drive tool controller stopped"))
        })
        yield* Effect.promise(() => server.stop(true))
      }),
  )
  const endpoint = `http://${server.hostname}:${server.port}`
  const plugin = fileURLToPath(new URL("./plugin.js", import.meta.url))
  const schemas = Object.fromEntries(
    [...definitions].map(([name, definition]) => [
      name,
      JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(definition.schema).schema)),
    ]),
  )

  return {
    configure(config) {
      const current = config.plugins
      if (current !== undefined && !Array.isArray(current))
        throw new Error("OpenCode config plugins must be an array")
      config.plugins = [
        ...(current ?? []),
        {
          package: plugin,
          options: { endpoint, token, tools: [...definitions.keys()], schemas },
        },
      ] as JsonValue
    },
  } satisfies Controller
})

function execute(
  request: Request,
  definition: Definition,
  index: number,
  active: Set<AbortController>,
) {
  const encoder = new TextEncoder()
  const transport = new TransformStream<Uint8Array, Uint8Array>()
  const writer = transport.writable.getWriter()
  const controller = new AbortController()
  const signal = AbortSignal.any([request.signal, controller.signal])
  active.add(controller)
  const send = (event: Event) =>
    Effect.suspend(() => {
      const frame = encoder.encode(`${JSON.stringify(event)}\n`)
      if (frame.byteLength > MAX_EVENT_BYTES)
        return Effect.die(new Error(`Drive tool event exceeds ${MAX_EVENT_BYTES} bytes`))
      return Effect.promise(() => writer.write(frame))
    })
  const result = Effect.gen(function* () {
    const input = yield* Effect.promise(() => request.json())
    return yield* definition.invoke(input, index, signal, (value) => send({ type: "progress", result: value }))
  })
  void writer.closed.catch((cause) => controller.abort(cause))
  void (async () => {
    try {
      const exit = await Effect.runPromise(Effect.exit(result), { signal })
      if (Exit.isSuccess(exit))
        await Effect.runPromise(send({ type: "success", result: exit.value }), { signal })
      else {
        const failure = Cause.findErrorOption(exit.cause)
        const error = Option.isSome(failure) ? failure.value : Cause.squash(exit.cause)
        await Effect.runPromise(
          send({
            type: "failure",
            message: error instanceof Failure
              ? error.message
              : error instanceof Error
                ? error.message
                : String(error),
          }),
          { signal },
        )
      }
      await writer.close()
    } catch (cause) {
      await writer.abort(cause).catch(() => undefined)
    } finally {
      active.delete(controller)
    }
  })()
  return new Response(transport.readable, {
    headers: { "content-type": "application/x-ndjson" },
  })
}
