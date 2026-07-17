import { describe, expect, test } from "vitest"
import { Backend, BackendSimulationClient, connectBackendSimulation } from "../../src/client/index.js"
import { sendResult, startTransportPeer } from "./transport-peer.js"

const exchanges = {
  early: {
    id: "exchange-early",
    url: "https://api.openai.com/v1/responses",
    body: { model: "test-model", input: "early" },
  },
  first: {
    id: "exchange-first",
    url: "https://api.openai.com/v1/responses",
    body: { model: "test-model", input: "first" },
  },
  second: {
    id: "exchange-second",
    url: "https://api.openai.com/v1/responses",
    body: { model: "test-model", input: "second" },
  },
} as const

function sendNotification(socket: Bun.ServerWebSocket<undefined>, method: string, params: unknown) {
  socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }))
}

describe("OpenCode backend simulation transport", () => {
  test("preserves exact frames, sequential IDs, results, and finish defaults", async () => {
    const peer = startTransportPeer(({ request, socket }) => {
      sendResult(socket, request, request.method === "llm.attach" ? { attached: true } : { ok: true })
    })
    let client: BackendSimulationClient | undefined

    try {
      client = await connectBackendSimulation({ url: peer.url })

      expect(client).toBeInstanceOf(BackendSimulationClient)
      expect(client.url).toBe(peer.url)

      const results = [
        await client.attach(() => {}),
        await client.chunk("exchange-1", [
          { type: "textDelta", text: "answer" },
          { type: "reasoningDelta", text: "thinking" },
          {
            type: "toolCall",
            index: 0,
            id: "call-1",
            name: "read",
            input: { path: "README.md" },
          },
          { type: "raw", chunk: { usage: { outputTokens: 2 } } },
        ]),
        await client.finish("exchange-1"),
        await client.finish("exchange-2", "stop"),
        await client.finish("exchange-3", "tool-calls"),
        await client.finish("exchange-4", "length"),
        await client.finish("exchange-5", "content-filter"),
        await client.disconnect("exchange-6"),
      ]

      expect(results).toEqual([
        { attached: true },
        { ok: true },
        { ok: true },
        { ok: true },
        { ok: true },
        { ok: true },
        { ok: true },
        { ok: true },
      ])

      const frames = [
        { jsonrpc: "2.0", id: 1, method: "llm.attach" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "llm.chunk",
          params: {
            id: "exchange-1",
            items: [
              { type: "textDelta", text: "answer" },
              { type: "reasoningDelta", text: "thinking" },
              {
                type: "toolCall",
                index: 0,
                id: "call-1",
                name: "read",
                input: { path: "README.md" },
              },
              { type: "raw", chunk: { usage: { outputTokens: 2 } } },
            ],
          },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "llm.finish",
          params: { id: "exchange-1" },
        },
        {
          jsonrpc: "2.0",
          id: 4,
          method: "llm.finish",
          params: { id: "exchange-2", reason: "stop" },
        },
        {
          jsonrpc: "2.0",
          id: 5,
          method: "llm.finish",
          params: { id: "exchange-3", reason: "tool-calls" },
        },
        {
          jsonrpc: "2.0",
          id: 6,
          method: "llm.finish",
          params: { id: "exchange-4", reason: "length" },
        },
        {
          jsonrpc: "2.0",
          id: 7,
          method: "llm.finish",
          params: { id: "exchange-5", reason: "content-filter" },
        },
        {
          jsonrpc: "2.0",
          id: 8,
          method: "llm.disconnect",
          params: { id: "exchange-6" },
        },
      ]

      expect(peer.received.map(({ raw }) => raw)).toEqual(frames.map((frame) => JSON.stringify(frame)))
      expect(peer.received.map(({ request }) => request)).toEqual(frames)

      expect(Backend.decodeRequest(peer.received[2]!.request)).toEqual({
        jsonrpc: "2.0",
        id: 3,
        method: "llm.finish",
        params: { id: "exchange-1", reason: "stop" },
      })
      expect(peer.received[2]!.raw).toBe(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "llm.finish",
          params: { id: "exchange-1" },
        }),
      )
    } finally {
      client?.close()
      await peer.stop()
    }
  })

  test("delivers an llm.request sent before the attach response", async () => {
    const peer = startTransportPeer(({ request, socket }) => {
      sendNotification(socket, "llm.request", exchanges.early)
      sendResult(socket, request, { attached: true })
    })
    let client: BackendSimulationClient | undefined

    try {
      client = await connectBackendSimulation({ url: peer.url })
      const received: Backend.OpenedExchange[] = []

      expect(await client.attach((request) => received.push(request))).toEqual({
        attached: true,
      })
      expect(received).toEqual([exchanges.early])
    } finally {
      client?.close()
      await peer.stop()
    }
  })

  test("preserves notification order and ignores unknown notifications without consuming response waiters", async () => {
    const peer = startTransportPeer(({ request, socket }) => {
      if (request.method === "llm.attach") {
        sendResult(socket, request, { attached: true })
        return
      }

      sendNotification(socket, "llm.request", exchanges.first)
      sendNotification(socket, "server.status", { ready: true })
      sendNotification(socket, "llm.request", exchanges.second)
      sendResult(socket, request, { ok: true })
    })
    let client: BackendSimulationClient | undefined

    try {
      client = await connectBackendSimulation({ url: peer.url })
      const received: Backend.OpenedExchange[] = []
      await client.attach((request) => received.push(request))

      expect(await client.chunk("exchange-1", [{ type: "textDelta", text: "response" }])).toEqual({ ok: true })
      expect(received).toEqual([exchanges.first, exchanges.second])
    } finally {
      client?.close()
      await peer.stop()
    }
  })
})
