import { defineScript } from "../../src/index.js"

export default defineScript(async ({ signal }) => {
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
})
