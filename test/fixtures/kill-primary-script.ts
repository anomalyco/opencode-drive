import { defineScript } from "opencode-drive"

export default defineScript({
  async run({ ui }) {
    await ui.kill()
    let closed = false
    try {
      await ui.state()
    } catch {
      closed = true
    }
    if (!closed) throw new Error("primary client remained connected after ui.kill()")
  },
})
