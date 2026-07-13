export interface WireRequest {
  readonly jsonrpc: "2.0"
  readonly id: number
  readonly method: string
  readonly params?: unknown
}

export interface ReceivedRequest {
  readonly raw: string
  readonly request: WireRequest
  readonly socket: Bun.ServerWebSocket<undefined>
}

export function startTransportPeer(
  onRequest: (received: ReceivedRequest) => void,
) {
  const received: ReceivedRequest[] = []
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: undefined })) return
      return new Response("simulation transport test peer", { status: 426 })
    },
    websocket: {
      message(socket, message) {
        const raw = String(message)
        const value = { raw, request: JSON.parse(raw) as WireRequest, socket }
        received.push(value)
        onRequest(value)
      },
    },
  })

  return {
    url: `ws://127.0.0.1:${server.port}`,
    received,
    stop: () => server.stop(true),
  }
}

export function sendResult(
  socket: Bun.ServerWebSocket<undefined>,
  request: WireRequest,
  result: unknown,
) {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }))
}

export function sendError(
  socket: Bun.ServerWebSocket<undefined>,
  request: WireRequest,
  message: string,
) {
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32000, message },
    }),
  )
}
