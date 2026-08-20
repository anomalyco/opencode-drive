import { afterEach, describe, expect, it } from "vitest"
import { makeChaosProxy, type ChaosProxy } from "../../src/instance/proxy.js"

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function makeUpstream() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/echo") return new Response("pong")
      if (url.pathname === "/stream") {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder()
            for (let index = 0; index < 5; index++) {
              controller.enqueue(encoder.encode(`chunk-${index}\n`))
              await Bun.sleep(30)
            }
            controller.close()
          },
        })
        return new Response(stream, {
          headers: { "content-type": "text/plain" },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  cleanups.push(() => server.stop(true))
  return server
}

function makeProxy(upstream: { port: number }): ChaosProxy {
  const proxy = makeChaosProxy({
    resolveTarget: () =>
      Promise.resolve({ hostname: "127.0.0.1", port: upstream.port }),
  })
  cleanups.push(() => proxy.close())
  return proxy
}

describe("chaos proxy", () => {
  it("forwards requests unimpaired by default", async () => {
    const proxy = makeProxy(makeUpstream())
    const response = await fetch(`${proxy.url}/echo`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("pong")
  })

  it("adds latency while preserving chunk order", async () => {
    const proxy = makeProxy(makeUpstream())
    proxy.set({ latencyMs: 100 })
    const started = Date.now()
    const response = await fetch(`${proxy.url}/echo`)
    const body = await response.text()
    const elapsed = Date.now() - started
    expect(body).toBe("pong")
    // Request and response each cross the proxy once.
    expect(elapsed).toBeGreaterThanOrEqual(190)

    proxy.set({ latencyMs: 20, jitterMs: 50 })
    const streamed = await fetch(`${proxy.url}/stream`)
    expect(await streamed.text()).toBe(
      "chunk-0\nchunk-1\nchunk-2\nchunk-3\nchunk-4\n",
    )
  })

  it("kills established connections mid-stream", async () => {
    const proxy = makeProxy(makeUpstream())
    const response = await fetch(`${proxy.url}/stream`)
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(proxy.connections()).toBeGreaterThan(0)
    expect(proxy.killConnections()).toBeGreaterThan(0)
    await expect(async () => {
      for (;;) {
        const next = await reader.read()
        if (next.done) return
      }
    }).rejects.toThrow()
    expect(proxy.connections()).toBe(0)
  })

  it("refuses new connections while keeping established ones", async () => {
    const proxy = makeProxy(makeUpstream())
    const response = await fetch(`${proxy.url}/stream`)
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)

    proxy.set({ refuseNew: true })
    await expect(fetch(`${proxy.url}/echo`)).rejects.toThrow()

    // The established stream still completes.
    let body = ""
    const decoder = new TextDecoder()
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      body += decoder.decode(next.value)
    }
    expect(body).toContain("chunk-4")

    proxy.set({})
    const recovered = await fetch(`${proxy.url}/echo`)
    expect(await recovered.text()).toBe("pong")
  })

  it("stalls traffic in a blackhole and flushes when cleared", async () => {
    const proxy = makeProxy(makeUpstream())
    proxy.set({ blackhole: true })
    const pending = fetch(`${proxy.url}/echo`)
    const timeout = Symbol("timeout")
    const stalled = await Promise.race([pending, Bun.sleep(200).then(() => timeout)])
    expect(stalled).toBe(timeout)

    proxy.set({})
    const response = await pending
    expect(await response.text()).toBe("pong")
  })

  it("terminates connections when the upstream is gone", async () => {
    const upstream = makeUpstream()
    const proxy = makeProxy(upstream)
    upstream.stop(true)
    await expect(fetch(`${proxy.url}/echo`)).rejects.toThrow()
  })
})
