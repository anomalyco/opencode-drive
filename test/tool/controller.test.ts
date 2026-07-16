import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as ToolController from "../../src/tool/controller.js"
import { Failure } from "../../src/tool/index.js"
import type { OpenCodeConfig } from "../../src/script/types.js"

it.effect("streams progress before shell success and failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const controller = yield* ToolController.make((tools) => {
        tools.handle("shell", ({ input, index, progress }) =>
          Effect.gen(function* () {
            yield* progress(`running ${index}: ${input.command}\n`)
            if (input.command === "fail")
              return yield* new Failure({ message: "controlled failure" })
            return { output: "controlled success\n", exit: 7 }
          }),
        )
      })
      const config: OpenCodeConfig = { plugins: ["existing-plugin"] }
      controller.configure(config)
      const plugins = config.plugins as Array<unknown>
      expect(plugins[0]).toBe("existing-plugin")
      const injected = plugins[1] as {
        package: string
        options: { endpoint: string; token: string; tools: string[] }
      }
      expect(injected.package.startsWith("/")).toBe(true)
      expect(injected.options.tools).toEqual(["shell"])

      const invoke = (command: string) =>
        Effect.promise(async () => {
          const response = await fetch(`${injected.options.endpoint}/execute/shell`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${injected.options.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ command }),
          })
          return (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
        })

      expect(yield* invoke("succeed")).toEqual([
        { type: "progress", result: { output: "running 0: succeed\n" } },
        { type: "success", result: { output: "controlled success\n", exit: 7 } },
      ])
      expect(yield* invoke("fail")).toEqual([
        { type: "progress", result: { output: "running 1: fail\n" } },
        { type: "failure", message: "controlled failure" },
      ])
    }),
  ),
)

it.effect("does not inject a plugin without handlers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const controller = yield* ToolController.make()
      const config: OpenCodeConfig = {}
      controller.configure(config)
      expect(config).toEqual({})
    }),
  ),
)

it.effect("routes typed webfetch and websearch handlers independently", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const controller = yield* ToolController.make((tools) => {
        tools.handle("webfetch", ({ input, index }) =>
          Effect.succeed({ output: `${index}:${input.format}:${input.url}` }),
        )
        tools.handle("websearch", ({ input, index }) =>
          Effect.succeed({ output: `${index}:${input.query}`, provider: "exa" }),
        )
      })
      const config: OpenCodeConfig = {}
      controller.configure(config)
      const injected = (config.plugins as Array<{
        options: { endpoint: string; token: string; tools: string[] }
      }>)[0]!
      expect(injected.options.tools).toEqual(["webfetch", "websearch"])

      const invoke = (name: string, input: unknown) =>
        Effect.promise(async () => {
          const response = await fetch(`${injected.options.endpoint}/execute/${name}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${injected.options.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(input),
          })
          return (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
        })

      expect(yield* invoke("webfetch", { url: "https://example.com" })).toEqual([
        {
          type: "success",
          result: { output: "0:markdown:https://example.com" },
        },
      ])
      expect(yield* invoke("websearch", { query: "effect typescript" })).toEqual([
        {
          type: "success",
          result: { output: "0:effect typescript", provider: "exa" },
        },
      ])
    }),
  ),
)

it.effect("aborts a handler when its transport disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>()
      const aborted = Promise.withResolvers<void>()
      const controller = yield* ToolController.make((tools) => {
        tools.handle("shell", ({ signal }) =>
          Effect.gen(function* () {
            signal.addEventListener("abort", () => aborted.resolve(), { once: true })
            started.resolve()
            return yield* Effect.never
          }),
        )
      })
      const config: OpenCodeConfig = {}
      controller.configure(config)
      const injected = (config.plugins as Array<{
        options: { endpoint: string; token: string }
      }>)[0]!
      const request = new AbortController()
      const response = fetch(`${injected.options.endpoint}/execute/shell`, {
        method: "POST",
        signal: request.signal,
        headers: {
          authorization: `Bearer ${injected.options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ command: "wait" }),
      }).catch(() => undefined)
      yield* Effect.promise(() => started.promise)
      request.abort()
      yield* Effect.promise(() => aborted.promise)
      yield* Effect.promise(() => response)
    }),
  ),
)
