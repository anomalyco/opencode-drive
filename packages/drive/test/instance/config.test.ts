import { afterEach, describe, expect, test } from "vitest"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import {
  initializeInstance,
  prepareInstanceProject,
} from "../../src/instance/instance.js"

const artifacts: string[] = []

afterEach(async () => {
  await Promise.all(
    artifacts.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  )
})

describe("instance configuration", () => {
  test("initializes the simulation provider with the current OpenCode provider shape", async () => {
    const root = await initializeInstance()
    artifacts.push(root)

    expect(await Bun.file(join(root, "files", ".opencode", "opencode.jsonc")).json()).toMatchObject({
      model: "simulation/gpt-sim-model",
      providers: {
        simulation: {
          package: "@opencode-ai/ai/providers/openai/chat",
          settings: { apiKey: "sim-key" },
        },
      },
    })
  })

  test("merges V2 CLI JSONC fixtures, replaces arrays, applies setup last, and commits normalized files", async () => {
    const root = await initializeInstance()
    artifacts.push(root)
    await Effect.runPromise(prepareInstanceProject({
      artifacts: root,
      project: {
        git: true,
        files: {
          ".opencode/opencode.jsonc": `{
            // fixture values are the merge base
            "nested": { "fixture": true, "winner": "fixture" },
            "items": ["fixture"],
          }`,
          ".opencode/cli.json": `{
            // CLI fixtures also accept comments and trailing commas
            "$schema": "https://opencode.ai/v2/cli.json",
            "theme": { "name": "tokyonight", "mode": "light" },
            "session": { "new_location": "launch" },
            "keybinds": { "app.exit": ["ctrl+c", "ctrl+d"] },
          }`,
        },
      },
      config: {
        nested: { declared: true, winner: "declared" },
        items: ["declared"],
      },
      tui: {
        theme: { name: "catppuccin" },
        session: { new_location: "inherit" },
        keybinds: { "app.exit": ["ctrl+q"] },
      },
      setup({ config, tuiConfig }) {
        return Effect.sync(() => {
          config.nested = {
            ...(config.nested as Record<string, boolean | string>),
            winner: "setup",
          }
          expect(tuiConfig.theme).toEqual({ name: "catppuccin", mode: "light" })
          expect(tuiConfig.keybinds).toEqual({ "app.exit": ["ctrl+q"] })
          tuiConfig.theme = { name: "opencode", mode: "light" }
          tuiConfig.keybinds = { "app.exit": ["ctrl+x"], "session.new": "ctrl+n" }
        })
      },
    }))

    const files = join(root, "files")
    const configText = await Bun.file(
      join(files, ".opencode", "opencode.jsonc"),
    ).text()
    const cliText = await Bun.file(
      join(files, ".opencode", "cli.json"),
    ).text()
    expect(JSON.parse(configText)).toEqual({
      nested: { fixture: true, declared: true, winner: "setup" },
      items: ["declared"],
    })
    const cli = {
      $schema: "https://opencode.ai/v2/cli.json",
      theme: { name: "opencode", mode: "light" },
      session: { new_location: "inherit" },
      keybinds: { "app.exit": ["ctrl+x"], "session.new": "ctrl+n" },
    }
    expect(cliText).toBe(`${JSON.stringify(cli, undefined, 2)}\n`)
    expect(await Bun.file(join(files, ".opencode", "tui.jsonc")).exists()).toBe(false)
    expect(configText).not.toContain("//")
    expect(await git(files, ["status", "--porcelain"])).toBe("")
    expect(await git(files, ["show", "HEAD:.opencode/cli.json"])).toBe(cliText)
  })

  test("prepares only the isolated V2 CLI configuration when no overrides are supplied", async () => {
    const root = await initializeInstance()
    artifacts.push(root)
    await Effect.runPromise(prepareInstanceProject({ artifacts: root }))

    expect(await Bun.file(join(root, "files", ".opencode", "cli.json")).text()).toBe("{}\n")
    expect(await Bun.file(join(root, "files", ".opencode", "tui.jsonc")).exists()).toBe(false)
    expect(await Bun.file(join(root, "home", ".config", "opencode", "cli.json")).exists()).toBe(false)
  })

  test.each(["{ invalid", "null", "[]"])("rejects invalid CLI JSONC configuration: %s", async (contents) => {
    const root = await initializeInstance()
    artifacts.push(root)
    await expect(
      Effect.runPromise(prepareInstanceProject({
        artifacts: root,
        project: {
          files: { ".opencode/cli.json": contents },
        },
      })),
    ).rejects.toThrow("invalid .opencode/cli.json")
  })

  test("does not let setup mutate declarative configuration inputs", async () => {
    const root = await initializeInstance()
    artifacts.push(root)
    const config = { nested: { value: "declared" }, items: ["declared"] }
    const tui = { keybinds: { "app.exit": "ctrl+q" } }

    await Effect.runPromise(prepareInstanceProject({
      artifacts: root,
      config,
      tui,
      setup({ config, tuiConfig }) {
        return Effect.sync(() => {
          const nested = config.nested as Record<string, string>
          const items = config.items as Array<string>
          const keybinds = tuiConfig.keybinds as Record<string, string>
          nested.value = "setup"
          items.push("setup")
          keybinds["app.exit"] = "ctrl+x"
        })
      },
    }))

    expect(config).toEqual({
      nested: { value: "declared" },
      items: ["declared"],
    })
    expect(tui).toEqual({ keybinds: { "app.exit": "ctrl+q" } })
  })

  test("interrupts setup with project preparation", async () => {
    const root = await initializeInstance()
    artifacts.push(root)
    const started = Promise.withResolvers<void>()
    let finalized = false
    const controller = new AbortController()
    const prepared = Effect.runPromise(
      prepareInstanceProject({
        artifacts: root,
        setup: () =>
          Effect.sync(() => started.resolve()).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => {
              finalized = true
            })),
          ),
      }),
      { signal: controller.signal },
    )

    await started.promise
    controller.abort()
    await expect(prepared).rejects.toThrow()
    expect(finalized).toBe(true)
  })
})

async function git(cwd: string, args: ReadonlyArray<string>) {
  return Bun.$`git ${args}`.cwd(cwd).text()
}
