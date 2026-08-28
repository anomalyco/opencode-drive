import { Effect, Schema } from "effect"
import { fileURLToPath } from "node:url"
import { makeChaosProxy } from "../../src/instance/proxy.js"
import type { OpenCodeConfig } from "../../src/project.js"
import { make } from "../../src/tool/controller.js"

// Test-only transport control: neither the tool API nor the TUI network is
// involved in dropping this real plugin/controller HTTP connection.
export const makeTransport = Effect.fn("ToolTransport.make")(function* () {
  const controller = yield* make(["shell"])
  const config: OpenCodeConfig = {}
  controller.configure(config)
  const injected = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({
    package: Schema.String,
    options: Schema.Struct({
      endpoint: Schema.String,
      token: Schema.String,
      tools: Schema.Array(Schema.String),
      schemas: Schema.Record(Schema.String, Schema.Json),
    }),
  })))(config.plugins)
  const plugin = injected[0]
  if (plugin === undefined) return yield* Effect.die(new Error("tool plugin was not configured"))
  const endpoint = new URL(plugin.options.endpoint)
  const proxy = yield* Effect.acquireRelease(
    Effect.sync(() => makeChaosProxy({
      resolveTarget: () => Promise.resolve({ hostname: endpoint.hostname, port: Number(endpoint.port) }),
    })),
    (proxy) => Effect.sync(() => proxy.close()),
  )
  const options = { ...plugin.options, endpoint: proxy.url }
  // `drive run` bundles this internal fixture, so locate the unbundled plugin
  // through the package entrypoint rather than the compiled module's URL.
  config.plugins = [{
    ...plugin,
    package: fileURLToPath(new URL("./tool/plugin.js", import.meta.resolve("opencode-drive"))),
    options,
  }]
  const shells = yield* controller.controls.control("shell")
  return { config, options, proxy, shells }
})
