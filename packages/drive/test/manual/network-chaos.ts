import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { defineScript, Llm } from "../../src/index.js"

// Manual smoke for the chaos network proxy: the TUI is pinned to the proxy
// with --server, so every HTTP and SSE byte crosses controllable conditions
// while the drive control plane stays clean.
//
//   bun run drive start --name chaos --script test/manual/network-chaos.ts \
//     --dev /path/to/opencode

export default defineScript({
  network: true,
  llm: { settlementTimeout: 120_000 },

  run: ({ llm, ui, network }) =>
    Effect.gen(function* () {
      yield* llm.serve((request) => {
        const body = JSON.stringify(request.body)
        if (body.includes("title generator"))
          return Stream.make(Llm.text("Network chaos smoke"))
        // The request body carries the whole conversation, so route on the
        // marker that appears LAST: that one belongs to the newest prompt.
        switch (latest(body, ["BASELINE", "LATENCY", "KILLDROP", "BLACKHOLE"])) {
          case "BASELINE":
            return Stream.make(Llm.text("BASELINE_ROUNDTRIP_OK"))
          case "LATENCY":
            return Stream.make(Llm.text("LATENCY_ROUNDTRIP_OK"))
          case "KILLDROP":
            return Stream.make(
              Llm.text("KILLDROP_STARTED"),
              Llm.pause(4_000),
              Llm.text(" KILLDROP_RECOVERED_OK"),
            )
          case "BLACKHOLE":
            return Stream.make(Llm.text("BLACKHOLE_ROUNDTRIP_OK"))
          default:
            return Stream.make(Llm.text("UNEXPECTED_PROMPT"))
        }
      })

      // 1. Baseline: an unimpaired round trip through the proxy.
      yield* ui.submit("BASELINE ping")
      yield* ui.waitFor("BASELINE_ROUNDTRIP_OK", { timeout: 20_000 })
      yield* ui.screenshot("chaos-baseline")

      // 2. Latency: 400ms each way, jittered. Still converges.
      yield* network.set({ latencyMs: 400, jitterMs: 200 })
      yield* ui.submit("LATENCY ping")
      yield* ui.waitFor("LATENCY_ROUNDTRIP_OK", { timeout: 30_000 })
      yield* network.clear()
      yield* ui.screenshot("chaos-latency")

      // 3. Kill every connection mid-stream: the TUI must reconnect through
      // the proxy and render the rest of the response.
      yield* ui.submit("KILLDROP ping")
      yield* ui.waitFor("KILLDROP_STARTED", { timeout: 20_000 })
      yield* network.killConnections()
      yield* ui.waitFor("KILLDROP_RECOVERED_OK", { timeout: 45_000 })
      yield* ui.screenshot("chaos-killdrop")

      // 4. Blackhole: submit while the network is stalled, then heal it.
      yield* network.set({ blackhole: true })
      yield* ui.submit("BLACKHOLE ping")
      yield* Effect.sleep(2_000)
      yield* ui.screenshot("chaos-blackhole-stalled")
      yield* network.clear()
      yield* ui.waitFor("BLACKHOLE_ROUNDTRIP_OK", { timeout: 45_000 })
      yield* ui.screenshot("chaos-blackhole-healed")
    }),
})

function latest(body: string, markers: ReadonlyArray<string>) {
  let found: string | undefined
  let position = -1
  for (const marker of markers) {
    const index = body.lastIndexOf(marker)
    if (index > position) {
      position = index
      found = marker
    }
  }
  return found
}
