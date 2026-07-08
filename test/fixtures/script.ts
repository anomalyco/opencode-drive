import { join } from "node:path"
import { defineScript } from "../../src/index.js"

export default defineScript(async ({ artifacts, backend, ui }) => {
  const attached = await backend.attach(() => {})
  await ui.typeText("script-text")
  await ui.screenshot("script-shot")
  const state = await ui.state()
  await Bun.write(
    join(artifacts, "script-result.json"),
    `${JSON.stringify({ focused: state.focused, attached }, undefined, 2)}\n`,
  )
})
