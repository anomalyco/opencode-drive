import { describe, expect, test } from "vitest"
import {
  BackendSimulationClient,
  BackendSimulationError,
  SimulationClient,
  SimulationError,
  SimulationProtocol,
  connectBackendSimulation,
  connectSimulation,
  defaultBackendPort,
  defaultPort,
} from "../../src/client/index.js"
import { type ReceivedRequest, sendError, sendResult, startTransportPeer } from "./transport-peer.js"

function captureRequests() {
  const queued: ReceivedRequest[] = []
  const waiters: Array<(request: ReceivedRequest) => void> = []

  return {
    onRequest(request: ReceivedRequest) {
      const waiter = waiters.shift()
      if (waiter === undefined) queued.push(request)
      else waiter(request)
    },
    next(): Promise<ReceivedRequest> {
      const request = queued.shift()
      if (request !== undefined) return Promise.resolve(request)
      return new Promise((resolve) => waiters.push(resolve))
    },
  }
}

describe("OpenCode simulation transport lifecycle", () => {
  test("exports default ports and clients connected by explicit URL", async () => {
    const uiPeer = startTransportPeer(() => {})
    const backendPeer = startTransportPeer(() => {})
    let ui: SimulationClient | undefined
    let backend: BackendSimulationClient | undefined

    try {
      expect(defaultPort).toBe(40900)
      expect(defaultBackendPort).toBe(40950)
      expect(Object.keys(SimulationProtocol).sort()).toEqual([
        "Backend",
        "Frontend",
        "Handshake",
        "JsonRpc",
      ])

      const clients = await Promise.all([
        connectSimulation({ url: uiPeer.url }),
        connectBackendSimulation({ url: backendPeer.url }),
      ])
      ui = clients[0]
      backend = clients[1]

      expect(ui).toBeInstanceOf(SimulationClient)
      expect(ui.url).toBe(uiPeer.url)
      expect(backend).toBeInstanceOf(BackendSimulationClient)
      expect(backend.url).toBe(backendPeer.url)
    } finally {
      ui?.close()
      backend?.close()
      await Promise.all([uiPeer.stop(), backendPeer.stop()])
    }
  })

  test("correlates concurrent UI responses by ID and ignores unknown IDs", async () => {
    const capture = captureRequests()
    const peer = startTransportPeer(capture.onRequest)
    const client = await connectSimulation({ url: peer.url })
    const state = { focused: { renderable: 7, editor: true }, elements: [] }

    try {
      const stateResult = client.state()
      const matchesResult = client.matches("ready")
      const stateRequest = await capture.next()
      const matchesRequest = await capture.next()

      expect(stateRequest.request.method).toBe("ui.state")
      expect(matchesRequest.request.method).toBe("ui.matches")

      stateRequest.socket.send(JSON.stringify({ jsonrpc: "2.0", id: 999, result: "unknown" }))
      sendResult(matchesRequest.socket, matchesRequest.request, true)
      sendResult(stateRequest.socket, stateRequest.request, state)

      expect(await matchesResult).toBe(true)
      expect(await stateResult).toEqual(state)
    } finally {
      client.close()
      await peer.stop()
    }
  })

  test("maps JSON-RPC errors to SimulationError with the originating method", async () => {
    const capture = captureRequests()
    const peer = startTransportPeer(capture.onRequest)
    const client = await connectSimulation({ url: peer.url })

    try {
      const result = client.matches("missing").catch((error) => error)
      const received = await capture.next()
      sendError(received.socket, received.request, "renderer unavailable")

      const error = await result
      expect(error).toBeInstanceOf(SimulationError)
      expect(error).toMatchObject({
        message: "renderer unavailable",
        method: "ui.matches",
      })
    } finally {
      client.close()
      await peer.stop()
    }
  })

  test("times out silently and remains usable for a subsequent UI call", async () => {
    const capture = captureRequests()
    const peer = startTransportPeer(capture.onRequest)
    const client = await connectSimulation({ url: peer.url, timeout: 25 })

    try {
      const timedOut = client.state().catch((error) => error)
      const silentRequest = await capture.next()
      expect(silentRequest.request.method).toBe("ui.state")

      const error = await timedOut
      expect(error).toBeInstanceOf(SimulationError)
      expect(error).toMatchObject({
        message: "timed out after 25ms",
        method: "ui.state",
      })

      const recovered = client.matches("ready")
      const recoveredRequest = await capture.next()
      sendResult(recoveredRequest.socket, recoveredRequest.request, true)

      expect(await recovered).toBe(true)
      expect(peer.received.map(({ request }) => request.method)).toEqual(["ui.state", "ui.matches"])
    } finally {
      client.close()
      await peer.stop()
    }
  })

  test("peer close rejects every pending UI request", async () => {
    const capture = captureRequests()
    const peer = startTransportPeer(capture.onRequest)
    const client = await connectSimulation({ url: peer.url })

    try {
      const stateResult = client.state().catch((error) => error)
      const matchesResult = client.matches("ready").catch((error) => error)
      await capture.next()
      await capture.next()

      await peer.stop()

      expect(await stateResult).toMatchObject({
        name: "SimulationError",
        message: "connection closed",
      })
      expect(await matchesResult).toMatchObject({
        name: "SimulationError",
        message: "connection closed",
      })
    } finally {
      client.close()
      await peer.stop()
    }
  })

  test("backend closed resolves when its peer closes", async () => {
    const capture = captureRequests()
    const peer = startTransportPeer(capture.onRequest)
    const client = await connectBackendSimulation({ url: peer.url })

    try {
      const attached = client.attach(() => {}).catch((error) => error)
      await capture.next()
      await peer.stop()

      await client.closed
      expect(await attached).toMatchObject({
        name: "BackendSimulationError",
        message: "connection closed",
      })
    } finally {
      client.close()
      await peer.stop()
    }
  })

  test("calls after local close reject as not open", async () => {
    const uiPeer = startTransportPeer(() => {})
    const backendPeer = startTransportPeer(() => {})
    const [ui, backend] = await Promise.all([
      connectSimulation({ url: uiPeer.url }),
      connectBackendSimulation({ url: backendPeer.url }),
    ])

    try {
      ui.close()
      backend.close()

      const uiError = await ui.state().catch((error) => error)
      expect(uiError).toBeInstanceOf(SimulationError)
      expect(uiError).toMatchObject({
        message: "connection is not open",
        method: "ui.state",
      })

      const backendError = await backend.call("llm.attach").catch((error) => error)
      expect(backendError).toBeInstanceOf(BackendSimulationError)
      expect(backendError).toMatchObject({
        message: "connection is not open",
        method: "llm.attach",
      })
    } finally {
      ui.close()
      backend.close()
      await Promise.all([uiPeer.stop(), backendPeer.stop()])
    }
  })

  test("local close rejects pending UI and backend calls as connection closed", async () => {
    const uiCapture = captureRequests()
    const backendCapture = captureRequests()
    const uiPeer = startTransportPeer(uiCapture.onRequest)
    const backendPeer = startTransportPeer(backendCapture.onRequest)
    const [ui, backend] = await Promise.all([
      connectSimulation({ url: uiPeer.url }),
      connectBackendSimulation({ url: backendPeer.url }),
    ])

    try {
      const uiResult = ui.state().catch((error) => error)
      const backendResult = backend.call("llm.attach").catch((error) => error)
      await Promise.all([uiCapture.next(), backendCapture.next()])

      ui.close()
      backend.close()

      expect(await uiResult).toMatchObject({
        name: "SimulationError",
        message: "connection closed",
        method: "ui.state",
      })
      expect(await backendResult).toMatchObject({
        name: "BackendSimulationError",
        message: "connection closed",
        method: "llm.attach",
      })
      await backend.closed
    } finally {
      ui.close()
      backend.close()
      await Promise.all([uiPeer.stop(), backendPeer.stop()])
    }
  })
})
