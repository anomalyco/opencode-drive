import { appendFile, mkdir } from "node:fs/promises"
import { extname, join } from "node:path"
import type { CliRenderer, Renderable } from "@opentui/core"
import { createMockKeys, createMockMouse, KeyCodes } from "@opentui/core/testing"
import { renderFrame } from "../recording/render.js"

interface Manifest {
  readonly endpoints: { readonly ui: string; readonly backend: string }
  readonly viewport?: { readonly cols: number; readonly rows: number }
  readonly recording?: { readonly timeline: string }
}

interface RpcRequest {
  readonly jsonrpc?: string
  readonly id?: string | number
  readonly method?: string
  readonly params?: Record<string, unknown>
}

interface Exchange {
  readonly id: string
  readonly body: unknown
  readonly stream: ReadableStreamDefaultController<Uint8Array>
}

interface PluginInput {
  readonly api: { readonly renderer: CliRenderer }
}

interface ControlSocket {
  send(message: string): unknown
}

const encoder = new TextEncoder()
const frontendCapabilities = [
  "ui.type",
  "ui.press",
  "ui.enter",
  "ui.arrow",
  "ui.focus",
  "ui.click",
  "ui.resize",
  "ui.matches",
  "ui.screenshot",
  "ui.state",
  "ui.capture",
  "ui.recording.finish",
]
const backendCapabilities = [
  "llm.attach",
  "llm.chunk",
  "llm.finish",
  "llm.disconnect",
  "llm.pending",
  "llm.request",
  "llm.tool-input-delta",
]

export function createDrivePluginHost() {
  const servers: Bun.Server<{ readonly role: "ui" | "backend" }>[] = []
  return {
    start(input: PluginInput) {
      void resolveManifest().then((manifest) => {
        if (manifest.viewport) input.api.renderer.resize(manifest.viewport.cols, manifest.viewport.rows)
        servers.push(startUi(input.api.renderer, manifest), startDevBackend(manifest))
      })
      return Promise.resolve()
    },
    async dispose() {
      await Promise.all(servers.splice(0).map((server) => server.stop(true)))
    },
  }
}

export async function waitForDriveProvider(transport: {
  readonly url: string
  readonly headers: RequestInit["headers"]
}) {
  const url = new URL("/api/provider", transport.url)
  url.searchParams.set("location[directory]", process.cwd())
  const started = performance.now()
  while (performance.now() - started < 10_000) {
    const response = await fetch(url, { headers: transport.headers })
    if (response.ok) {
      const value: unknown = await response.json()
      if (
        isRecord(value) &&
        Array.isArray(value.data) &&
        value.data.some((provider) => isRecord(provider) && provider.id === "simulation")
      ) return
    }
    await Bun.sleep(20)
  }
  throw new Error("Timed out waiting for the Drive simulation provider")
}

export function driveLegacyFallback(pathname: string) {
  const provider = {
    id: "simulation",
    name: "Simulation",
    source: "config",
    env: [],
    options: {},
    models: {
      "gpt-sim-model": {
        id: "gpt-sim-model",
        providerID: "simulation",
        api: {
          id: "gpt-sim-model",
          url: "https://api.openai.com/v1",
          npm: "@ai-sdk/openai-compatible",
        },
        name: "Simulated Model",
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 128_000, output: 16_000 },
        status: "active",
        options: {},
        headers: {},
        release_date: "1970-01-01",
      },
    },
  }
  if (pathname === "/config/providers")
    return {
      providers: [provider],
      default: { simulation: "gpt-sim-model" },
    }
  if (pathname === "/provider")
    return {
      all: [provider],
      default: { simulation: "gpt-sim-model" },
      connected: ["simulation"],
    }
  return undefined
}

function startUi(renderer: CliRenderer, manifest: Manifest) {
  const input = createMockKeys(renderer)
  const mouse = createMockMouse(renderer)
  const endpoint = new URL(manifest.endpoints.ui)
  const started = performance.now()
  const render = async () => {
    renderer.requestRender()
    await renderer.idle()
  }
  const record = async () => {
    if (!manifest.recording) return
    await appendFile(
      manifest.recording.timeline,
      `${JSON.stringify({
        type: "output",
        at_ms: Math.max(0, Math.round(performance.now() - started)),
        data: Buffer.from(screen(renderer)).toString("base64"),
      })}\n`,
    )
  }
  if (manifest.recording)
    void Bun.write(
      manifest.recording.timeline,
      `${JSON.stringify({
        type: "header",
        version: 1,
        cols: manifest.viewport?.cols ?? 80,
        rows: manifest.viewport?.rows ?? 24,
        encoding: "base64",
      })}\n`,
    )

  return Bun.serve<{ readonly role: "ui" }>({
    hostname: endpoint.hostname,
    port: Number(endpoint.port),
    fetch(request, server) {
      if (server.upgrade(request, { data: { role: "ui" } })) return undefined
      return new Response("Drive UI WebSocket", { status: 426 })
    },
    websocket: {
      async message(socket, message) {
        const request = decodeRequest(message)
        if (!request) return sendError(socket, undefined, -32600, "Invalid JSON-RPC request")
        try {
          const result = await handleUi(request, renderer, input, mouse, manifest, render, record)
          sendResult(socket, request.id, result)
        } catch (cause) {
          sendError(socket, request.id, -32000, cause instanceof Error ? cause.message : String(cause))
        }
      },
    },
  })
}

export function startDevBackend(manifest: Manifest) {
  const endpoint = new URL(manifest.endpoints.backend)
  const pending = new Map<string, Exchange>()
  let controller: ControlSocket | undefined
  let counter = 0

  const notify = (exchange: Exchange) =>
    controller?.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "llm.request",
      params: {
        id: exchange.id,
        url: "https://api.openai.com/v1/chat/completions",
        body: exchange.body,
      },
    }))

  return Bun.serve<{ readonly role: "backend" }>({
    hostname: endpoint.hostname,
    port: Number(endpoint.port),
    idleTimeout: 255,
    async fetch(request, server) {
      if (server.upgrade(request, { data: { role: "backend" } })) return undefined
      const url = new URL(request.url)
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions"))
        return Response.json({ error: "Not found" }, { status: 404 })
      const body: unknown = await request.json()
      const id = `ex_${++counter}`
      const stream = new ReadableStream<Uint8Array>({
        start(stream) {
          const exchange = { id, body, stream }
          pending.set(id, exchange)
          notify(exchange)
        },
        cancel() {
          pending.delete(id)
        },
      })
      return new Response(stream, {
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
          connection: "keep-alive",
        },
      })
    },
    websocket: {
      message(socket, message) {
        const request = decodeRequest(message)
        if (!request) return sendError(socket, undefined, -32600, "Invalid JSON-RPC request")
        if (request.method === "simulation.handshake")
          return sendResult(socket, request.id, handshake("backend", backendCapabilities))
        if (request.method === "llm.attach") {
          controller = socket
          pending.forEach(notify)
          return sendResult(socket, request.id, { attached: true })
        }
        if (request.method === "llm.pending")
          return sendResult(socket, request.id, {
            invocations: [...pending.values()].map((item) => ({ id: item.id, url: "https://api.openai.com/v1/chat/completions", body: item.body })),
          })
        const id = typeof request.params?.id === "string" ? request.params.id : undefined
        const exchange = id === undefined ? undefined : pending.get(id)
        if (!exchange) return sendError(socket, request.id, -32000, `Simulated provider request not found: ${id}`)
        if (request.method === "llm.chunk") {
          const items = Array.isArray(request.params?.items) ? request.params.items : []
          items.forEach((item) => exchange.stream.enqueue(sseChunk(providerChunk(item))))
          return sendResult(socket, request.id, { ok: true })
        }
        if (request.method === "llm.finish") {
          exchange.stream.enqueue(sseChunk({
            choices: [{ delta: {}, finish_reason: finishReason(request.params?.reason) }],
          }))
          exchange.stream.enqueue(encoder.encode("data: [DONE]\n\n"))
          exchange.stream.close()
          pending.delete(exchange.id)
          return sendResult(socket, request.id, { ok: true })
        }
        if (request.method === "llm.disconnect") {
          exchange.stream.error(new Error("simulated provider disconnected"))
          pending.delete(exchange.id)
          return sendResult(socket, request.id, { ok: true })
        }
        return sendError(socket, request.id, -32601, `Method not found: ${request.method}`)
      },
      close(socket) {
        if (controller !== socket) return
        controller = undefined
      },
    },
  })
}

async function handleUi(
  request: RpcRequest,
  renderer: CliRenderer,
  input: ReturnType<typeof createMockKeys>,
  mouse: ReturnType<typeof createMockMouse>,
  manifest: Manifest,
  render: () => Promise<void>,
  record: () => Promise<void>,
) {
  if (request.method === "simulation.handshake") return handshake("ui", frontendCapabilities)
  if (request.method === "ui.capture") {
    await render()
    return capture(renderer)
  }
  if (request.method === "ui.matches")
    return screen(renderer).includes(typeof request.params?.text === "string" ? request.params.text : "")
  if (request.method === "ui.state") return state(renderer)
  if (request.method === "ui.snapshot") return { format: "opencode-ui-snapshot-v1", nodes: [] }
  if (request.method === "ui.screenshot") {
    const name = typeof request.params?.name === "string" ? request.params.name : `screenshot-${crypto.randomUUID()}`
    if (!name || name.includes("/") || name.includes("\\") || extname(name))
      throw new Error("screenshot name must not contain a path or extension")
    await render()
    const directory = process.env.OPENCODE_DRIVE_MEDIA_DIR ?? join(Bun.env.TMPDIR ?? "/tmp", "opencode-drive", "output")
    await mkdir(directory, { recursive: true })
    const path = join(directory, `${name}.png`)
    await Bun.write(path, renderFrame(toRecordingFrame(capture(renderer))))
    return path
  }
  if (request.method === "ui.recording.finish") {
    if (!manifest.recording) throw new Error("UI recording is not available")
    await record()
    return manifest.recording.timeline
  }
  if (request.method === "ui.type")
    await input.typeText(typeof request.params?.text === "string" ? request.params.text : "")
  if (request.method === "ui.enter") input.pressEnter()
  if (request.method === "ui.arrow" && isDirection(request.params?.direction)) input.pressArrow(request.params.direction)
  if (request.method === "ui.press") {
    const key = typeof request.params?.key === "string" ? request.params.key : ""
    const named = key.toUpperCase()
    input.pressKey(
      isKeyCode(named) ? named : key,
      isModifiers(request.params?.modifiers) ? request.params.modifiers : undefined,
    )
  }
  if (request.method === "ui.focus") all(renderer.root).find((item) => item.num === request.params?.target)?.focus()
  if (request.method === "ui.click") {
    const target = all(renderer.root).find((item) => item.num === request.params?.target)
    if (!target || !target.visible || target.isDestroyed)
      throw new Error(`click target is stale or unavailable: ${String(request.params?.target)}`)
    await mouse.click(target.screenX + Number(request.params?.x ?? 0), target.screenY + Number(request.params?.y ?? 0))
  }
  if (request.method === "ui.resize") renderer.resize(Number(request.params?.cols), Number(request.params?.rows))
  await render()
  await record()
  return state(renderer)
}

function capture(renderer: CliRenderer) {
  const buffer = renderer.currentRenderBuffer
  return {
    cols: buffer.width,
    rows: buffer.height,
    cursor: [0, 0] as const,
    lines: buffer.getSpanLines().map((line) => ({
      spans: line.spans.map((span) => ({
        text: span.text,
        fg: span.fg.toInts(),
        bg: span.bg.toInts(),
        attributes: span.attributes,
        width: span.width,
      })),
    })),
  }
}

function state(renderer: CliRenderer) {
  return {
    focused: {
      renderable: renderer.currentFocusedRenderable?.num,
      editor: Boolean(renderer.currentFocusedEditor),
    },
    elements: all(renderer.root)
      .filter((item) => item.visible && !item.isDestroyed)
      .map((item) => ({
        id: item.id,
        num: item.num,
        x: item.screenX,
        y: item.screenY,
        width: item.width,
        height: item.height,
        focusable: item.focusable,
        focused: item.focused,
        clickable: hasMouseListener(item),
        editor: renderer.currentFocusedEditor === item,
      }))
      .filter((item) => item.focusable || item.clickable || item.editor),
  }
}

function providerChunk(value: unknown) {
  if (!isRecord(value) || typeof value.type !== "string") return value
  if (value.type === "raw") return value.chunk
  if (value.type === "textDelta") return { choices: [{ delta: { content: value.text } }] }
  if (value.type === "reasoningDelta") return { choices: [{ delta: { reasoning_content: value.text } }] }
  if (value.type === "toolInputStart")
    return { choices: [{ delta: { tool_calls: [{ index: value.index, id: value.id, function: { name: value.name, arguments: "" } }] } }] }
  if (value.type === "toolInputDelta")
    return { choices: [{ delta: { tool_calls: [{ index: value.index, function: { arguments: value.text } }] } }] }
  if (value.type === "toolCall")
    return { choices: [{ delta: { tool_calls: [{ index: value.index, id: value.id, function: { name: value.name, arguments: JSON.stringify(value.input) } }] } }] }
  return value
}

function finishReason(reason: unknown) {
  if (reason === "tool-calls") return "tool_calls"
  if (reason === "content-filter") return "content_filter"
  return reason === "length" ? "length" : "stop"
}

function handshake(role: "ui" | "backend", capabilities: readonly string[]) {
  return {
    protocolVersion: 1,
    role,
    server: { name: "opencode", version: "dev" },
    capabilities,
  }
}

function decodeRequest(message: string | Buffer) {
  try {
    const value: unknown = JSON.parse(String(message))
    return isRecord(value) && value.jsonrpc === "2.0" && typeof value.method === "string" ? value as RpcRequest : undefined
  } catch {
    return undefined
  }
}

function sendResult(socket: ControlSocket, id: RpcRequest["id"], result: unknown) {
  if (id === undefined) return
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }))
}

function sendError(socket: ControlSocket, id: RpcRequest["id"], code: number, message: string) {
  if (id === undefined) return
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }))
}

function sseChunk(value: unknown) {
  return encoder.encode(`data: ${JSON.stringify(value)}\n\n`)
}

function all(renderable: Renderable): Renderable[] {
  const children = renderable.getChildren().filter((child): child is Renderable => "num" in child)
  return [renderable, ...children.flatMap(all)]
}

function hasMouseListener(renderable: Renderable) {
  const listener = Reflect.get(renderable, "_mouseListener")
  const listeners = Reflect.get(renderable, "_mouseListeners")
  return Boolean(listener) || (isRecord(listeners) && Object.keys(listeners).length > 0)
}

function screen(renderer: CliRenderer) {
  return new TextDecoder().decode(renderer.currentRenderBuffer.getRealCharBytes())
}

function toRecordingFrame(frame: ReturnType<typeof capture>) {
  return {
    cols: frame.cols,
    rows: frame.rows,
    cursor: { row: 0, col: 0, visible: false },
    lines: frame.lines.map((line) => ({
      spans: line.spans.map((span) => ({
        ...span,
        fg: rgb(span.fg),
        bg: rgb(span.bg),
      })),
    })),
  }
}

function rgb(value: readonly number[]) {
  return ((value[0] ?? 0) << 16) | ((value[1] ?? 0) << 8) | (value[2] ?? 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isModifiers(value: unknown): value is {
  readonly shift?: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly super?: boolean
  readonly hyper?: boolean
} {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "boolean")
}

function isDirection(value: unknown): value is "up" | "down" | "left" | "right" {
  return value === "up" || value === "down" || value === "left" || value === "right"
}

function isKeyCode(value: string): value is keyof typeof KeyCodes {
  return Object.hasOwn(KeyCodes, value)
}

async function resolveManifest() {
  const name = process.env.OPENCODE_DRIVE
  const directory = process.env.DRIVE_REGISTRY_DIR
  if (!name || !directory) throw new Error("Drive manifest environment is unavailable")
  const value: unknown = await Bun.file(join(directory, `${name}.json`)).json()
  if (!isManifest(value)) throw new Error("Drive manifest is invalid")
  return value
}

function isManifest(value: unknown): value is Manifest {
  if (!isRecord(value) || !isRecord(value.endpoints)) return false
  return typeof value.endpoints.ui === "string" && typeof value.endpoints.backend === "string"
}
