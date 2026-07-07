import { join } from "node:path"
import { defineDriver } from "../../src/experimental/drive.js"

export default defineDriver(async ({ artifacts, ui }) => {
  await ui.typeText("driver-text")
  const state = await ui.state()
  if (!state.screen.includes("driver-text")) throw new Error("driver text did not render")
  await Bun.write(join(artifacts, "driver-result.json"), `${JSON.stringify({ screen: state.screen }, undefined, 2)}\n`)
})
