import { executeCommands } from "./commands.js"
import type { SendOptions } from "./types.js"
import { defaultPort } from "../client/index.js"
import { resolveInstance, resolveVisibleInstance } from "../instance/registry.js"

export async function send(options: SendOptions) {
  if (options.commands.length === 0)
    throw new Error("send requires at least one --command.ui.* flag")
  const result = await executeCommands(await resolveSendEndpoint(options.name), options.commands)
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
    ["ui.state"].includes(
      options.commands[0]?.operation ?? "",
    )
  ) {
    console.log(JSON.stringify(result.results[0]?.result, undefined, 2))
    return
  }
  console.log("success")
}

export async function resolveSendEndpoint(name?: string) {
  if (name) return (await resolveInstance(name)).endpoints.ui
  return (
    (await resolveVisibleInstance())?.endpoints.ui ?? `ws://127.0.0.1:${defaultPort}`
  )
}
