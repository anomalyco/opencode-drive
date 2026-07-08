import { defineScript } from "../src/index.js"

export default defineScript(async ({ ui, backend }) => {
  const completed = deferred()
  let exchange = 0

  await backend.attach(async (request) => {
    if (isTitleRequest(request.body)) {
      await backend.chunk(request.id, [
        { type: "textDelta", text: "Three tools at once" },
      ])
      await backend.finish(request.id)
      return
    }

    if (exchange++ === 0) {
      await backend.chunk(request.id, [
        {
          type: "toolCall",
          index: 0,
          id: "call_glob_garden",
          name: "glob",
          input: { pattern: "src/**/*.js" },
        },
        {
          type: "toolCall",
          index: 1,
          id: "call_read_garden",
          name: "read",
          input: { path: "src/garden.js", offset: 1, limit: 120 },
        },
        {
          type: "toolCall",
          index: 2,
          id: "call_patch_garden",
          name: "apply_patch",
          input: {
            patchText:
              '*** Begin Patch\n*** Update File: src/garden.js\n@@\n-export function greet(name) {\n-  return `Hello, ${name}.`\n+export function greet(name, punctuation = "!") {\n+  const visitor = name.trim() || "traveler"\n+  return `Hello, ${visitor}${punctuation}`\n }\n*** End Patch',
          },
        },
      ])
      await backend.finish(request.id, "tool-calls")
      return
    }

    for (const text of [
      "Three tools set out together: ",
      "one mapped the JavaScript files, ",
      "one read the existing function, ",
      "and one made the change. ",
      "Their results returned independently, ",
      "and the updated greeting is now in place.",
    ]) {
      await backend.chunk(request.id, [{ type: "textDelta", text }])
      await Bun.sleep(300)
    }
    await backend.finish(request.id)
    completed.resolve()
  })

  await ui.typeText(
    "Inspect the greeting function and improve how it handles a blank name.",
  )
  await ui.pressEnter()
  await waitFor(completed.promise)
  await waitForEditor(ui)
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitFor(promise: Promise<void>) {
  const completed = await Promise.race([
    promise.then(() => true),
    Bun.sleep(30_000).then(() => false),
  ])
  if (!completed) throw new Error("timed out waiting for the tool continuation")
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
  return messages.some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "content" in message &&
      typeof message.content === "string" &&
      message.content.includes("You are a title generator"),
  )
}
