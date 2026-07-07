import { resolve } from "node:path"
import { executeCommands } from "./commands.js"
import { runCampaign } from "../experimental/cli-campaign.js"
import { runDriver } from "./driver.js"
import { launchInstance } from "./instance.js"
import type { StartOptions } from "./types.js"

export async function start(options: StartOptions) {
  if (options.campaign) return runCampaign(options)
  const instance = await launchInstance({
    name: options.name,
    command: options.command,
    dev: options.dev,
    state: options.state,
    visible: options.visible,
  })
  console.error(`opencode-drive: ${instance.manifest.name}`)
  console.error(`opencode-drive: artifacts ${instance.manifest.artifacts}`)
  console.error(`opencode-drive: send commands with opencode-drive send --name ${instance.manifest.name}`)
  if (options.detach) {
    await instance.waitForDrive("both")
    await instance.detach()
    return
  }
  const interrupt = () => void instance.stop()
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  try {
    if (options.commands.length > 0) {
      await instance.waitForDrive("both")
      const result = await executeCommands(instance.manifest, options.commands)
      await instance.stop()
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
      await instance.waitForDrive("both")
      await runDriver(resolve(options.driver), instance.manifest)
      return
    }
    const status = await instance.child.exited
    if (status !== 0) process.exitCode = status
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
    await instance.stop()
  }
}
