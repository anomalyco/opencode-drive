import { executeCommands } from "./commands.js"
import type { SendOptions } from "./types.js"
import { defaultPort } from "../client/index.js"
import { resolveInstance, resolveVisibleInstance } from "../instance/registry.js"
import type { InstanceManifest } from "../instance/registry.js"
import { configureLogFile } from "../log.js"
import { readInstanceMediaDirectory } from "../instance/media.js"

export async function send(options: SendOptions) {
  if (options.commands.length === 0)
    throw new Error("send requires at least one --command.ui.* flag")
  const target = await resolveSendTarget(
    options.name,
    options.commands.some((command) => command.operation === "ui.screenshot"),
  )
  const result = await executeCommands(target.endpoint, options.commands, {
    screenshotDirectory: target.screenshotDirectory,
  })
  if (
    options.commands.length === 1 &&
    ["ui.screenshot", "ui.matches", "ui.recording.finish"].includes(
      options.commands[0]?.operation ?? "",
    )
  ) {
    console.log(result.results[0]?.result)
    return
  }
  if (
    options.commands.length === 1 &&
    ["ui.state", "ui.snapshot", "ui.capture"].includes(
      options.commands[0]?.operation ?? "",
    )
  ) {
    console.log(JSON.stringify(result.results[0]?.result, undefined, 2))
    return
  }
  console.log("success")
}

export async function resolveSendEndpoint(name?: string) {
  return (await resolveSendTarget(name)).endpoint
}

async function resolveSendTarget(name?: string, screenshot = false) {
  const manifest = name ? await resolveInstance(name) : await resolveVisibleInstance()
  if (manifest) {
    configureLogFile(manifest.artifacts)
    return {
      endpoint: manifest.endpoints.ui,
      ...(screenshot
        ? { screenshotDirectory: await resolveScreenshotDirectory(manifest) }
        : {}),
    }
  }
  return { endpoint: `ws://127.0.0.1:${defaultPort}` }
}

async function resolveScreenshotDirectory(manifest: InstanceManifest) {
  if (manifest.media) return manifest.media
  // Older running instances only persisted this path in their TUI manifest.
  return readInstanceMediaDirectory(manifest.artifacts, manifest.endpoints.ui)
}
