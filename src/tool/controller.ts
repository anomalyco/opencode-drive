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
  type Registry,
  type Setup,
  type ShellHandler,
} from "./types.js"

type Event =
  | { readonly type: "progress"; readonly result: ShellResult }
  | { readonly type: "success"; readonly result: ShellResult }
  | { readonly type: "failure"; readonly message: string }

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
  const handlers = new Map<string, ShellHandler>()
  const registry: Registry = {
    handle(name, handler) {
      if (handlers.has(name)) throw new Error(`tool handler already registered: ${name}`)
      handlers.set(name, handler)
    },
  }
  setup?.(registry)

  if (handlers.size === 0) {
    return { configure() {} } satisfies Controller
  }

  const token = crypto.randomUUID()
  let nextIndex = 0
  const active = new Set<AbortController>()
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          if (request.headers.get("authorization") !== `Bearer ${token}`)
            return new Response("Unauthorized", { status: 401 })
          const url = new URL(request.url)
          const name = url.pathname.match(/^\/execute\/([^/]+)$/)?.[1]
          const handler = name === undefined ? undefined : handlers.get(name)
          if (request.method !== "POST" || name === undefined)
            return new Response("Not found", { status: 404 })
          if (handler === undefined)
            return new Response("Tool handler not registered", { status: 404 })
          return execute(request, handler, nextIndex++, active)
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
  const shellSchema: JsonValue = JSON.parse(
    JSON.stringify(Schema.toJsonSchemaDocument(ShellInput).schema),
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
          options: {
            endpoint,
            token,
            tools: [...handlers.keys()],
            schemas: {
              shell: shellSchema,
            },
          },
        },
      ] as JsonValue
    },
  } satisfies Controller
})

function execute(
  request: Request,
  handler: ShellHandler,
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
    const input = yield* Schema.decodeUnknownEffect(ShellInput)(yield* Effect.promise(() => request.json()))
    const result = yield* handler({
      input,
      index,
      signal,
      progress: (value) =>
        send({
          type: "progress",
          result: typeof value === "string" ? { output: value } : value,
        }),
    })
    return yield* Schema.decodeUnknownEffect(ShellResult)(result)
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
