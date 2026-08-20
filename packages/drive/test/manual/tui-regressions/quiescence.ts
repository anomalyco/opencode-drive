import { defineScript } from "../../../src/index.js"
import { Effect } from "effect"
import { pacedReply, serveMarkers, settled } from "./support.js"

// Quiescence probe: after every terminal outcome — completed reply,
// escape-interrupt mid-stream, connections killed mid-stream, blackhole
// through a stream then heal — the UI must stop moving. No spinner may keep
// spinning, no timer may keep ticking, and the composer must be actionable.
// Detection is renderer-level: sample frames ~400ms apart and require them
// to be identical (cursor cell masked), so any lingering busy indicator is
// caught regardless of its copy.
//
//   bun run --cwd packages/drive drive start --name tui-quiescence \
//     --script test/manual/tui-regressions/quiescence.ts \
//     --dev "$OPENCODE_DEV"

export default defineScript({
  network: true,
  llm: { settlementTimeout: 180_000 },

  run: ({ ui, llm, network, opencode, artifacts }) =>
    Effect.gen(function* () {
      const router = yield* serveMarkers(llm, {
        title: "Quiescence probe",
        reply: pacedReply,
      })

      const failures: Array<{
        scenario: string
        unstable: Array<{ row: number; samples: Array<string> }>
      }> = []

      const requireQuiescence = (scenario: string) =>
        Effect.gen(function* () {
          const report = yield* settled(ui)
          if (report.stable) {
            console.error(
              JSON.stringify({ scenario, quiescent: true, waitedMs: report.waitedMs }),
            )
            return
          }
          failures.push({ scenario, unstable: report.unstable })
          console.error(
            JSON.stringify({ scenario, quiescent: false, unstable: report.unstable }),
          )
          yield* ui.screenshot(`not-quiescent-${scenario}`)
        })

      // Calibration: the idle home screen must read as stable, or the
      // detector itself is broken (e.g. cursor blink leaking into captures).
      yield* requireQuiescence("idle-baseline")
      if (failures.length > 0)
        return yield* Effect.fail(
          new Error("idle baseline is not stable; quiescence detection is unusable"),
        )

      // 1. Normal completion.
      router.track("M0X")
      yield* ui.submit("M0X run to completion")
      yield* ui.waitFor("M0X_DONE", { timeout: 30_000 })
      yield* requireQuiescence("completed-reply")

      // 2. Escape-interrupt mid-stream.
      router.track("M1X")
      yield* ui.submit("M1X interrupt me")
      yield* ui.waitFor("M1X_WORKING", { timeout: 30_000 })
      yield* Effect.sleep(300)
      // Interrupt is armed on the first escape and fired on the second (within 5s).
      yield* ui.press("escape")
      yield* Effect.sleep(200)
      yield* ui.press("escape")
      yield* ui.waitFor((state) => state.focused.editor, { timeout: 15_000 })
      yield* requireQuiescence("escape-interrupt")

      // 3. Connections killed mid-stream; server keeps streaming, the TUI
      // reconnects and must settle on the final state.
      router.track("M2X")
      yield* ui.submit("M2X kill my connection")
      yield* ui.waitFor("M2X_WORKING", { timeout: 30_000 })
      yield* network.killConnections()
      yield* ui.waitFor("M2X_DONE", { timeout: 60_000 })
      yield* requireQuiescence("killed-mid-stream")

      // 4. Blackhole through the stream, then heal and converge.
      router.track("M3X")
      yield* ui.submit("M3X ride out the partition")
      yield* ui.waitFor("M3X_WORKING", { timeout: 30_000 })
      yield* network.set({ blackhole: true })
      yield* Effect.sleep(4_000)
      yield* network.clear()
      yield* ui.waitFor("M3X_DONE", { timeout: 60_000 })
      yield* requireQuiescence("blackhole-heal")

      // The composer must still accept work after all of it.
      router.track("M4X")
      yield* ui.submit("M4X closing probe")
      yield* ui.waitFor("M4X_DONE", { timeout: 30_000 })

      console.log(
        JSON.stringify({
          scenarios: 5,
          failures: failures.map((failure) => failure.scenario),
        }),
      )
      if (failures.length > 0)
        return yield* Effect.fail(
          new Error(`UI failed to settle after: ${failures.map((f) => f.scenario).join(", ")}`),
        )
    }),
})
