import { resolve } from "node:path"

const dev = process.env.OPENCODE_DRIVE_DEV

if (dev !== undefined) {
  const cliTui = resolve(dev, "packages", "cli", "src", "tui.ts")
  const integration = new URL("./dev-integration.ts", import.meta.url).href

  Bun.plugin({
    name: "opencode-drive-dev",
    setup(build) {
      build.onLoad({ filter: /\/packages\/cli\/src\/tui\.ts$/ }, async (args) => {
        if (resolve(args.path) !== cliTui) return undefined
        const source = await Bun.file(args.path).text()
        const target = `pluginHost: {
      async start() {},
      async dispose() {},
    },`
        if (!source.includes(target)) throw new Error("Current OpenCode TUI plugin host seam was not found")
        const withIntegration = source.replace(
          'import { run } from "@opencode-ai/tui"',
          `import { run } from "@opencode-ai/tui"\nimport { createDrivePluginHost, driveLegacyFallback, waitForDriveProvider } from ${JSON.stringify(integration)}`,
        ).replace(target, "pluginHost: createDrivePluginHost(),")
        const withFallback = withIntegration.replace(
          "const fallback = legacyDefaults[new URL(input instanceof Request ? input.url : input).pathname]",
          "const pathname = new URL(input instanceof Request ? input.url : input).pathname\n    const fallback = driveLegacyFallback(pathname) ?? legacyDefaults[pathname]",
        )
        if (withFallback === withIntegration) throw new Error("Current OpenCode legacy provider fallback seam was not found")
        const delayed = withFallback
          .replace(
            "  return run({",
            "  return Effect.promise(() => waitForDriveProvider(transport)).pipe(Effect.andThen(run({",
          )
          .replace(
            "  }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))\n}",
            "  }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))))\n}",
          )
        if (delayed === withFallback) throw new Error("Current OpenCode TUI startup seam was not found")
        return {
          loader: "ts",
          contents: delayed,
        }
      })
    },
  })
}
