import { executeCommands } from "./commands.js"
import type { SendOptions } from "./types.js"
import { resolveInstance } from "./registry.js"

export async function send(options: SendOptions) {
  if (options.commands.length === 0)
    throw new Error("send requires at least one --command.ui.* flag")
  const instance = await resolveInstance(options.name)
  const result = await executeCommands(instance.endpoints.ui, options.commands)
  if (
    options.commands.length === 1 &&
    ["ui.screenshot", "ui.recording.finish"].includes(
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
