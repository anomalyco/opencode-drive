import { afterEach, expect, test } from "vitest"
import {
  driveLegacyFallback,
  startDevBackend,
  waitForDriveProvider,
} from "../../src/instance/dev-integration.js"

const servers: Bun.Server<unknown>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
})

test("bridges OpenAI-compatible requests through the Drive backend protocol", async () => {
  const server = startDevBackend({
    endpoints: {
      ui: "ws://127.0.0.1:1",
      backend: "ws://127.0.0.1:0",
    },
  })
  servers.push(server)
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`)
  const messages: unknown[] = []
  socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))))
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("backend WebSocket failed to open")), { once: true })
  })

  socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "llm.attach" }))
  await waitFor(() => messages.some((message) => isRecord(message) && message.id === 1))

  const response = fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-sim-model", stream: true, messages: [] }),
  })
  const request = await waitFor(() =>
    messages.find((message) =>
      isRecord(message) && message.method === "llm.request"
    ) as { readonly params?: { readonly id?: string } } | undefined)
  const id = request.params?.id
  if (typeof id !== "string") throw new Error("backend request did not include an ID")
  socket.send(JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "llm.chunk",
    params: { id, items: [{ type: "textDelta", text: "Current OpenCode works." }] },
  }))
  socket.send(JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "llm.finish",
    params: { id, reason: "stop" },
  }))

  expect(await (await response).text()).toContain('"content":"Current OpenCode works."')
  socket.close()
})

test("waits through the current OpenCode provider startup race", async () => {
  let requests = 0
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++
      return Response.json({
        data: requests < 3 ? [] : [{ id: "simulation" }],
      })
    },
  })
  servers.push(server)

  await waitForDriveProvider({ url: `http://127.0.0.1:${server.port}`, headers: {} })

  expect(requests).toBe(3)
})

test("fills the current TUI legacy bootstrap from the simulation provider", () => {
  expect(driveLegacyFallback("/config/providers")).toMatchObject({
    providers: [{ id: "simulation", models: { "gpt-sim-model": { capabilities: { interleaved: false } } } }],
    default: { simulation: "gpt-sim-model" },
  })
  expect(driveLegacyFallback("/provider")).toMatchObject({
    all: [{ id: "simulation", models: { "gpt-sim-model": { capabilities: { toolcall: true } } } }],
    connected: ["simulation"],
  })
})

async function waitFor<A>(evaluate: () => A | undefined | false, timeout = 2_000): Promise<A> {
  const started = performance.now()
  while (performance.now() - started < timeout) {
    const value = evaluate()
    if (value !== undefined && value !== false) return value
    await Bun.sleep(5)
  }
  throw new Error("timed out waiting for condition")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
