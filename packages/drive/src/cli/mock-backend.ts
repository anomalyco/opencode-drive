import { connectBackendSimulation } from "../client/index.js"
import { generateResponse } from "./response-generator.js"
import type { createResponseSettings } from "./response-generator.js"

export async function connectMockBackend(
  endpoint: string,
  responses: ReturnType<typeof createResponseSettings>,
) {
  const backend = await connectBackendSimulation({ url: endpoint })
  await backend.attach(async (request) => {
    const response = generateResponse(responses.current(), request)
    for (const item of response.items) {
      if (item.type !== "textDelta" && item.type !== "reasoningDelta") {
        await backend.chunk(request.id, [item])
        continue
      }
      for (const text of splitText(item.text)) {
        await backend.chunk(request.id, [{ ...item, text }])
        await Bun.sleep(45 + Math.floor(Math.random() * 35))
      }
    }
    await backend.finish(request.id, response.finish)
  })
  return {
    close() {
      backend.close()
    },
  }
}

export function splitText(text: string) {
  const words = text.match(/\S+\s*/g) ?? [text]
  return Array.from(
    { length: Math.ceil(words.length / 3) },
    (_, index) => words.slice(index * 3, index * 3 + 3).join(""),
  )
}
