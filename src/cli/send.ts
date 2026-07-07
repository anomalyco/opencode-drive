import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { defaultBackendPort, defaultPort } from "../client/index.js"
import { executeCommands } from "./commands.js"
import { runDriver } from "./driver.js"
import { resolveInstance } from "./registry.js"
import type { SendOptions } from "./types.js"

export async function send(options: SendOptions) {
  const manifest = options.name
    ? await resolveInstance(options.name)
    : await resolveInstance("default").catch(() => defaultManifest())
  if (options.commands.length > 0) {
    const result = await executeCommands(manifest, options.commands)
    if (options.commands.length === 1 && ["render", "end-record"].includes(options.commands[0]?.operation ?? "")) {
      console.log(result.results[0]?.result)
      return
    }
    if (options.commands.length === 1 && ["llm.pending", "state", "start-record"].includes(options.commands[0]?.operation ?? "")) {
      console.log(JSON.stringify(result.results[0]?.result, undefined, 2))
      return
    }
    console.log("success")
    return
  }
  if (options.driver) {
    await runDriver(resolve(options.driver), manifest)
    return
  }
  console.log(JSON.stringify(manifest, undefined, 2))
}

function defaultManifest() {
  return {
    version: 1 as const,
    name: "default",
    pid: 0,
    startedAt: new Date().toISOString(),
    mode: "real" as const,
    headless: false,
    cwd: process.cwd(),
    artifacts: join(tmpdir(), "opencode-drive", "default"),
    endpoints: {
      ui: `ws://127.0.0.1:${defaultPort}`,
      backend: `ws://127.0.0.1:${defaultBackendPort}`,
    },
  }
}
