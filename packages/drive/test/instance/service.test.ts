import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Effect from "effect/Effect"
import { stopService } from "../../src/instance/service.js"

const roots: Array<string> = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("stopService", () => {
  it("ignores unsafe process identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-drive-service-"))
    roots.push(root)
    const state = join(root, "state")
    await mkdir(join(state, "opencode"), { recursive: true })
    await Bun.write(join(state, "opencode", "service.json"), JSON.stringify({ pid: -1 }))
    const kill = vi.spyOn(process, "kill")

    await Effect.runPromise(stopService(state))

    expect(kill).not.toHaveBeenCalled()
  })
})
