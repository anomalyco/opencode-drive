import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  commitScriptProject,
  initializeScriptProject,
} from "../src/script/project.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("script project", () => {
  test("creates a clean Git baseline containing the declared files", async () => {
    const root = await temporary()
    await initializeScriptProject(root, {
      git: {
        files: {
          "src/example.ts": "export const value = 1\n",
        },
      },
    })
    await commitScriptProject(root)

    expect(await Bun.file(join(root, "src/example.ts")).text()).toBe(
      "export const value = 1\n",
    )
    expect(await git(root, ["status", "--porcelain"])).toBe("")
    expect((await git(root, ["log", "-1", "--format=%s"])).trim()).toBe(
      "Initial commit",
    )
  })

  test("rejects files outside the project", async () => {
    const root = await temporary()
    await expect(
      initializeScriptProject(root, {
        git: { files: { "../outside.ts": "no" } },
      }),
    ).rejects.toThrow("stay inside")
  })

  test("reserves Git metadata", async () => {
    const root = await temporary()
    await expect(
      initializeScriptProject(root, {
        git: { files: { ".git/config": "[core]\nworktree = /tmp\n" } },
      }),
    ).rejects.toThrow("must not modify Git metadata")
  })

  test("includes ignored files and replaces prepared Git metadata", async () => {
    const root = await temporary()
    await initializeScriptProject(root, {
      git: {
        files: {
          ".gitignore": "ignored.txt\n",
          "ignored.txt": "tracked baseline\n",
        },
      },
    })
    await mkdir(join(root, ".git"))
    await Bun.write(join(root, ".git", "config"), "[core]\nworktree = /tmp\n")
    await commitScriptProject(root)

    expect((await git(root, ["ls-files"])).split("\n")).toContain("ignored.txt")
    expect(await git(root, ["status", "--porcelain"])).toBe("")
  })
})

async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "opencode-drive-project-test-"))
  roots.push(root)
  return root
}

async function git(cwd: string, args: ReadonlyArray<string>) {
  return Bun.$`git ${args}`.cwd(cwd).text()
}
