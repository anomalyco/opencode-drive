import { afterEach, describe, expect, test } from "vitest"
import { rm } from "node:fs/promises"
import { join } from "node:path"
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
  test("merges JSONC fixtures, replaces arrays, applies setup last, and commits normalized files", async () => {
    const root = await initializeInstance()
    artifacts.push(root)
    await prepareInstanceProject({
      artifacts: root,
      project: {
        git: true,
        files: {
          ".opencode/opencode.jsonc": `{
            // fixture values are the merge base
            "nested": { "fixture": true, "winner": "fixture" },
            "items": ["fixture"],
          }`,
          ".opencode/tui.jsonc": `{
            "theme": { "fixture": true },
            "items": ["fixture"],
          }`,
        },
      },
      config: {
        nested: { declared: true, winner: "declared" },
        items: ["declared"],
      },
      tui: {
        theme: { declared: true },
        items: ["declared"],
      },
      setup({ config, tui }) {
        config.nested = {
          ...(config.nested as Record<string, boolean | string>),
          winner: "setup",
        }
        tui.items = ["setup"]
      },
    })

    const files = join(root, "files")
    const configText = await Bun.file(
      join(files, ".opencode", "opencode.jsonc"),
    ).text()
    const tuiText = await Bun.file(
      join(files, ".opencode", "tui.jsonc"),
    ).text()
    expect(JSON.parse(configText)).toEqual({
      nested: { fixture: true, declared: true, winner: "setup" },
      items: ["declared"],
    })
    expect(JSON.parse(tuiText)).toEqual({
      theme: { fixture: true, declared: true },
      items: ["setup"],
    })
    expect(configText).not.toContain("//")
    expect(await git(files, ["status", "--porcelain"])).toBe("")
    expect(await git(files, ["show", "HEAD:.opencode/tui.jsonc"])).toBe(tuiText)
  })

  test("rejects invalid JSONC configuration", async () => {
    const root = await initializeInstance()
    artifacts.push(root)
    await expect(
      prepareInstanceProject({
        artifacts: root,
        project: {
          files: { ".opencode/tui.jsonc": "{ invalid" },
        },
      }),
    ).rejects.toThrow("invalid .opencode/tui.jsonc")
  })
})

async function git(cwd: string, args: ReadonlyArray<string>) {
  return Bun.$`git ${args}`.cwd(cwd).text()
}
