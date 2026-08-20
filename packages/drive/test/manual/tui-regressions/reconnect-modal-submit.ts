import { defineScript } from "../../../src/index.js"
import { Effect } from "effect"
import { admissions, appeared, serveMarkers } from "./support.js"

// Classifies what happens to a prompt submitted while the TUI shows its
// reconnect overlay during a network partition. Distinguishes:
//   A. POST admitted (buffered by the partition, flushed on heal) — reply lands.
//   B. POST rejected — prompt rolls back and its text is restored to the composer.
//   C. Enter swallowed — no POST, text stays in the composer, nothing happens
//      after heal until a second enter.
// Note: a quiet blackhole alone does not raise the overlay; it needs a
// dropped connection (killConnections) while traffic is pending.
// (Result: B, and it is the honest path — the POST is rejected fast with a
// "Failed to send prompt · Transport" toast and the text stays in the
// composer through heal, awaiting a manual resend. The remaining issue is
// the overlay copy: "Restarting service..." during a pure network fault.)
//
//   bun run --cwd packages/drive drive start --name tui-reconnect-modal-submit \
//     --script test/manual/tui-regressions/reconnect-modal-submit.ts \
//     --dev "$OPENCODE_DEV"

export default defineScript({
  network: true,
  llm: { settlementTimeout: 120_000 },

  run: ({ ui, llm, network, opencode }) =>
    Effect.gen(function* () {
      const model = yield* serveMarkers(llm, { title: "Reconnect modal probe" })
      model.track("FIRST")
      model.track("SECOND")

      // Establish the session on a healthy network.
      yield* ui.submit("FIRST probe")
      yield* ui.waitFor("FIRST_DONE", { timeout: 20_000 })

      // Drop every connection and refuse new ones so the overlay appears.
      yield* network.set({ refuseNew: true })
      yield* network.killConnections()
      const overlay = yield* appeared(ui, "Restarting service", { timeout: 30_000 })
      yield* ui.screenshot("overlay")
      yield* ui.submit("SECOND probe")
      yield* Effect.sleep(1_500)
      yield* ui.screenshot("after-submit")

      yield* network.clear()
      yield* Effect.sleep(8_000)
      yield* ui.screenshot("healed")

      const admitted = yield* admissions(opencode, "SECOND")
      const replied = yield* appeared(ui, "SECOND_DONE", { timeout: 20_000 })
      console.log(
        JSON.stringify({
          overlay,
          admitted,
          replied,
          verdict:
            admitted === 1 && replied
              ? "A: admitted and replied after heal"
              : admitted === 1
                ? "A': admitted after heal, reply missing on screen"
                : "B or C: prompt never admitted — check screenshots for restore vs swallowed enter",
        }),
      )
    }),
})
