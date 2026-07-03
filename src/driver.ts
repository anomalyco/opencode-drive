import { connectBackendSimulation, connectSimulation, type OpenedExchange } from "./client/index.js"

const uiUrl = process.env.OPENCODE_SIMULATION_UI_WS
const backendUrl = process.env.OPENCODE_SIMULATION_BACKEND_WS

const ui = await connectSimulation(uiUrl ? { url: uiUrl } : undefined)
const backend = await connectBackendSimulation(backendUrl ? { url: backendUrl } : undefined)

console.log("ui:", ui.url)
console.log("backend:", backend.url)

await backend.attach(async (request: OpenedExchange) => {
  console.log("llm.request:", JSON.stringify({ id: request.id, model: (request.body as { model?: string }).model }))
  await backend.chunk(request.id, [{ type: "textDelta", text: "Hello from opencode-probe." }])
  await backend.finish(request.id, "stop")
})

await ui.typeText(process.argv.slice(2).join(" ") || "Hello from opencode-probe")
await ui.pressEnter()

for (let attempt = 0; attempt < 30; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  const state = await ui.render()
  if (state.screen.includes("Hello from opencode-probe.")) {
    console.log("screen ok")
    ui.close()
    backend.close()
    process.exit(0)
  }
}

console.log((await ui.state()).screen)
ui.close()
backend.close()
throw new Error("assistant reply did not render")
