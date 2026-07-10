import { defineScript } from "../../src/index.js"

export default defineScript({
  async run() {
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("leaked script server"),
    })
    throw new Error("script crashed")
  },
})
