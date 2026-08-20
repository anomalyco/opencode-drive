import type { Socket } from "bun"

// A chaos TCP proxy interposed between launched TUIs and the script's
// OpenCode server. TUIs are pinned to the proxy with `--server`, so every
// HTTP and SSE byte crosses this hop while the drive control plane (the
// simulation WebSocket channels) stays unaffected. The proxy resolves its
// upstream lazily per connection, so it transparently follows server
// restarts that change ports.

/** Network conditions applied to all proxied traffic. `set` replaces the whole state. */
export interface Conditions {
  /** Delay added to every forwarded chunk, in milliseconds. */
  readonly latencyMs?: number
  /** Extra random delay in [0, jitterMs) added per chunk. Ordering is preserved. */
  readonly jitterMs?: number
  /** Immediately close new incoming connections. Established connections continue. */
  readonly refuseNew?: boolean
  /** Stall all traffic without closing connections. Buffered bytes flush when cleared. */
  readonly blackhole?: boolean
}

interface Resolved {
  readonly latencyMs: number
  readonly jitterMs: number
  readonly refuseNew: boolean
  readonly blackhole: boolean
}

export interface Target {
  readonly hostname: string
  readonly port: number
}

export interface Options {
  /** Resolves the current upstream, called for each new connection. */
  readonly resolveTarget: () => Promise<Target | undefined>
  /** Random source for jitter, in [0, 1). Defaults to Math.random. */
  readonly random?: () => number
}

export interface ChaosProxy {
  readonly port: number
  readonly url: string
  /** Replaces the network conditions. Omitted fields reset to no-op defaults. */
  readonly set: (conditions: Conditions) => void
  readonly conditions: () => Conditions
  /** Abruptly terminates every proxied connection. Returns how many were killed. */
  readonly killConnections: () => number
  /** The number of live proxied connections. */
  readonly connections: () => number
  readonly close: () => void
}

const resolveConditions = (conditions: Conditions): Resolved => ({
  latencyMs: Math.max(0, conditions.latencyMs ?? 0),
  jitterMs: Math.max(0, conditions.jitterMs ?? 0),
  refuseNew: conditions.refuseNew ?? false,
  blackhole: conditions.blackhole ?? false,
})

type AnySocket = Socket | Socket<Pair>

/**
 * One direction of a proxied connection. Chunks are delivered in arrival
 * order after the configured delay; a blackhole pauses delivery without
 * dropping bytes, and the peer's FIN is forwarded only after the queue
 * drains so pure latency never corrupts a stream.
 */
class Pipe {
  private readonly queue: Array<{ readonly chunk: Uint8Array; readonly at: number }> = []
  private lastAt = 0
  private ended = false
  private endSent = false
  private timer: ReturnType<typeof setTimeout> | undefined
  peer: AnySocket | undefined

  constructor(
    private readonly state: () => Resolved,
    private readonly fail: () => void,
  ) {}

  push(chunk: Uint8Array, random: () => number) {
    if (this.endSent) return
    const conditions = this.state()
    const delay = conditions.latencyMs + conditions.jitterMs * random()
    const at = Math.max(Date.now() + delay, this.lastAt)
    this.lastAt = at
    this.queue.push({ chunk, at })
    this.pump()
  }

  end() {
    this.ended = true
    this.pump()
  }

  pump() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.endSent) return
    if (this.state().blackhole) return
    const peer = this.peer
    if (peer === undefined) return
    while (this.queue.length > 0) {
      const head = this.queue[0]!
      const wait = head.at - Date.now()
      if (wait > 0) {
        this.timer = setTimeout(() => this.pump(), wait)
        return
      }
      this.queue.shift()
      try {
        peer.write(head.chunk)
      } catch {
        this.fail()
        return
      }
    }
    if (this.ended) {
      this.endSent = true
      try {
        peer.end()
      } catch {
        // The peer is already gone.
      }
    }
  }

  destroy() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.queue.length = 0
    this.endSent = true
  }
}

interface Pair {
  /** Client bytes headed to the upstream server. */
  readonly up: Pipe
  /** Server bytes headed back to the client. */
  readonly down: Pipe
  client: Socket<Pair> | undefined
  upstream: Socket | undefined
  closed: boolean
}

export function makeChaosProxy(options: Options): ChaosProxy {
  const random = options.random ?? Math.random
  let conditions = resolveConditions({})
  const state = () => conditions
  const pairs = new Set<Pair>()

  const destroyPair = (pair: Pair, abrupt: boolean) => {
    if (pair.closed) return
    pair.closed = true
    pairs.delete(pair)
    pair.up.destroy()
    pair.down.destroy()
    for (const socket of [pair.client, pair.upstream]) {
      if (socket === undefined) continue
      try {
        if (abrupt) socket.terminate()
        else socket.end()
      } catch {
        // Already closed.
      }
    }
  }

  const connectUpstream = async (pair: Pair) => {
    const target = await options.resolveTarget()
    if (pair.closed) return
    if (target === undefined) {
      destroyPair(pair, true)
      return
    }
    try {
      await Bun.connect({
        hostname: target.hostname,
        port: target.port,
        socket: {
          open(socket) {
            if (pair.closed) {
              socket.terminate()
              return
            }
            pair.upstream = socket
            pair.up.peer = socket
            pair.up.pump()
          },
          data(_socket, chunk) {
            pair.down.push(chunk, random)
          },
          close() {
            pair.upstream = undefined
            pair.up.destroy()
            pair.down.end()
            if (pair.client === undefined) destroyPair(pair, true)
          },
          error() {
            destroyPair(pair, true)
          },
        },
      })
    } catch {
      destroyPair(pair, true)
    }
  }

  const listener = Bun.listen<Pair>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        if (conditions.refuseNew) {
          socket.terminate()
          return
        }
        let ref: Pair | undefined
        const fail = () => {
          if (ref !== undefined) destroyPair(ref, true)
        }
        const pair: Pair = {
          up: new Pipe(state, fail),
          down: new Pipe(state, fail),
          client: socket,
          upstream: undefined,
          closed: false,
        }
        ref = pair
        pair.down.peer = socket
        socket.data = pair
        pairs.add(pair)
        void connectUpstream(pair)
      },
      data(socket, chunk) {
        socket.data?.up.push(chunk, random)
      },
      close(socket) {
        const pair = socket.data
        if (pair === undefined || pair.closed) return
        pair.client = undefined
        pair.down.destroy()
        pair.up.end()
        if (pair.upstream === undefined) destroyPair(pair, true)
      },
      error(socket) {
        const pair = socket.data
        if (pair !== undefined) destroyPair(pair, true)
      },
    },
  })

  return {
    port: listener.port,
    url: `http://127.0.0.1:${listener.port}`,
    set(next) {
      conditions = resolveConditions(next)
      for (const pair of pairs) {
        pair.up.pump()
        pair.down.pump()
      }
    },
    conditions: () => conditions,
    killConnections() {
      const killed = pairs.size
      for (const pair of pairs) destroyPair(pair, true)
      return killed
    },
    connections: () => pairs.size,
    close() {
      for (const pair of pairs) destroyPair(pair, true)
      listener.stop(true)
    },
  }
}
