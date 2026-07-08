import { defineScript } from "../src/index.js"

export default defineScript(async ({ ui, backend, signal }) => {
  let exchange = 0

  await backend.attach(async (request) => {
    if (isTitleRequest(request.body)) {
      await backend.chunk(request.id, [
        { type: "textDelta", text: "Never-ending exploration" },
      ])
      await backend.finish(request.id)
      return
    }

    if (exchange++ > 0) return

    await backend.chunk(request.id, [
      {
        type: "toolCall",
        index: 0,
        id: "call_glob_forever",
        name: "glob",
        input: { pattern: "src/**/*.js" },
      },
      {
        type: "toolCall",
        index: 1,
        id: "call_read_forever",
        name: "read",
        input: { path: "src/garden.js" },
      },
    ])
    await backend.finish(request.id, "tool-calls")
  })

  await ui.typeText("Explore the source files.")
  await ui.pressEnter()
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  )
})

function isTitleRequest(body: unknown) {
  if (typeof body !== "object" || body === null || !("messages" in body))
    return false
  const messages = body.messages
  if (!Array.isArray(messages)) return false
  return messages.some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "content" in message &&
      typeof message.content === "string" &&
      message.content.includes("You are a title generator"),
  )
}
