import { defineScript } from "../src/index.js"

export default defineScript(async ({ ui, backend }) => {
  const completed = [deferred(), deferred()]
  let turn = 0

  await backend.attach(async (request) => {
    if (isTitleRequest(request.body)) {
      await backend.chunk(request.id, [
        { type: "textDelta", text: "A two-turn demonstration" },
      ])
      await backend.finish(request.id)
      return
    }

    const current = turn++
    const chunks =
      current === 0
        ? [
            "OpenCode Drive lets you ",
            "control the UI ",
            "and simulated model responses programmatically.",
          ]
        : [
            "This is the second turn. ",
            "Both responses were streamed live ",
            "while the UI was being recorded.",
          ]
    for (const text of chunks) {
      await backend.chunk(request.id, [{ type: "textDelta", text }])
      await Bun.sleep(500)
    }
    await backend.finish(request.id)
    completed[current]?.resolve()
  })

  await waitForEditor(ui)

  await ui.typeText("What does OpenCode Drive do?")
  await ui.pressEnter()
  await waitForTurn(completed[0].promise, 1)
  await waitForEditor(ui)

  await ui.typeText("Give me one more sentence about this recording.")
  await ui.pressEnter()
  await waitForTurn(completed[1].promise, 2)
  await waitForEditor(ui)
  await Bun.sleep(1_000)

})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitForTurn(promise: Promise<void>, turn: number) {
  const result = await Promise.race([
    promise.then(() => true),
    Bun.sleep(30_000).then(() => false),
  ])
  if (!result) throw new Error(`timed out waiting for LLM turn ${turn}`)
}

async function waitForEditor(
  ui: Parameters<Parameters<typeof defineScript>[0]>[0]["ui"],
) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if ((await ui.state()).focused.editor) return
    await Bun.sleep(50)
  }
  throw new Error("timed out waiting for the prompt editor")
}

function isTitleRequest(body: unknown) {
  if (typeof body !== "object" || body === null || !("messages" in body))
    return false
  const messages = body.messages
  if (!Array.isArray(messages)) return false
  return messages.some((message) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("content" in message)
    )
      return false
    return (
      typeof message.content === "string" &&
      message.content.includes("You are a title generator")
    )
  })
}
