import { mkdtemp, rm } from "node:fs/promises"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { listenControl } from "../../src/instance/control.js"

const roots: Array<string> = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("instance control", () => {
  it("closes while an idle client is connected", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-drive-control-"))
    roots.push(root)
    const path = join(root, "control.sock")
    const close = await listenControl(path, {
      restart: async () => undefined,
      stop: async () => ({ screenshots: [] }),
      responses: async () => ({ types: [], tools: [] }),
    })
    const socket = connect(path)
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
    })

    await expect(close()).resolves.toBeUndefined()
    expect(socket.destroyed).toBe(true)
  })
})
