import { join } from "node:path"
import { defineDriver } from "../../src/experimental/drive.js"

export default defineDriver(async ({ artifacts, ui }) => {
  await ui.typeText("driver-text")
  const state = await ui.state()
  if (!state.focused.editor) throw new Error("prompt editor is not focused")
  await Bun.write(join(artifacts, "driver-result.json"), `${JSON.stringify({ focused: state.focused }, undefined, 2)}\n`)
})
