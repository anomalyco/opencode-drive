import { afterEach, expect, test } from "vitest"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import * as Effect from "effect/Effect"
import { prepareDev } from "../../src/instance/dev.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

test("detects standalone V2 development checkouts without changing the base command", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode drive dev "))
  const artifacts = await mkdtemp(join(tmpdir(), "opencode-drive-artifacts-"))
  directories.push(root, artifacts)
  await mkdir(join(root, "packages", "cli", "src", "services"), { recursive: true })
  await mkdir(join(root, "packages", "tui", "node_modules", "@opentui", "solid", "scripts"), { recursive: true })
  await Promise.all([
    Bun.write(join(root, "packages", "cli", "src", "index.ts"), ""),
    Bun.write(join(root, "packages", "cli", "src", "services", "standalone.ts"), ""),
    Bun.write(
      join(root, "packages", "tui", "node_modules", "@opentui", "solid", "package.json"),
      JSON.stringify({ exports: { "./preload": "./scripts/preload.js" } }),
    ),
    Bun.write(join(root, "packages", "tui", "node_modules", "@opentui", "solid", "scripts", "preload.js"), ""),
  ])

  const result = await Effect.runPromise(prepareDev(artifacts, root))

  expect(result.standalone).toBe(true)
  expect(result.command.at(-1)).toBe(join(artifacts, "opencode-dev.ts"))
  expect(result.command).toContain(
    `--preload=${join(root, "packages", "tui", "node_modules", "@opentui", "solid", "scripts", "preload.js")}`,
  )
  expect(result.bunOptions).toEqual(["--conditions=browser", "--preload=@opentui/solid/preload"])
  expect(await Bun.file(join(artifacts, "opencode-dev.ts")).text()).toContain(
    `await import(${JSON.stringify(pathToFileURL(join(root, "packages", "cli", "src", "index.ts")).href)})`,
  )

  const output = join(artifacts, "server-environment.json")
  await Bun.write(
    join(root, "packages", "cli", "src", "index.ts"),
    `await Bun.write(${JSON.stringify(output)}, JSON.stringify({ args: process.argv.slice(2), bunOptions: process.env.BUN_OPTIONS }))\n`,
  )
  const server = Bun.spawn([...result.command, "serve", "--service"], {
    cwd: artifacts,
    env: { ...process.env, BUN_OPTIONS: result.bunOptions.join(" ") },
    stderr: "pipe",
  })
  const [status, stderr] = await Promise.all([server.exited, new Response(server.stderr).text()])
  expect(stderr).toBe("")
  expect(status).toBe(0)
  expect(await Bun.file(output).json()).toEqual({ args: ["serve", "--service"] })
})
