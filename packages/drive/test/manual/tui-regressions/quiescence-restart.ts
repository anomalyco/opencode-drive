import { defineScript, Llm } from "../../../src/index.js"
import { Config, Effect, Stream } from "effect"
import { settled } from "./support.js"

// Server-restart quiescence: kill the service while a reply is mid-stream,
// relaunch it, and require the rehydrated transcript to settle. The streamed
// assistant message was never finalized in the database, so rehydration must
// resolve it to a terminal state — a transcript row that keeps a live
// spinner or busy indicator after restart is the bug this hunts.
//
//   OPENCODE_DRIVE_DB=quiescence.sqlite \
//     bun run --cwd packages/drive drive start --name tui-quiescence-restart \
//     --script test/manual/tui-regressions/quiescence-restart.ts \
//     --dev "$OPENCODE_DEV"

export default defineScript({
  launch: "manual",
  llm: { settlementTimeout: 180_000 },

  run: ({ server, tuis, llm }) =>
    Effect.gen(function* () {
      yield* Config.string("OPENCODE_DRIVE_DB")
      const markers: Array<string> = []
      yield* llm.serve((request) => {
        const body = JSON.stringify(request.body)
        if (body.includes("title generator")) return Stream.make(Llm.text("Quiescence restart probe"))
        let marker: string | undefined
        let position = -1
        for (const candidate of markers) {
          const index = body.lastIndexOf(candidate)
          if (index > position) {
            position = index
            marker = candidate
          }
        }
        if (marker === undefined) return Stream.make(Llm.text("GAUNTLET_UNMATCHED_PROMPT"))
        return Stream.make(
          Llm.text(`${marker}_WORKING `),
          Llm.pause(1_500),
          Llm.text("streaming across the restart "),
          Llm.pause(1_500),
          Llm.text(`${marker}_DONE`),
        )
      })

      yield* server.launch()
      const tui = yield* tuis.launch("quiescence-restart")
      const ui = tui.ui

      const failures: Array<string> = []
      const requireQuiescence = (scenario: string) =>
        Effect.gen(function* () {
          const report = yield* settled(ui, { deadlineMs: 20_000 })
          console.error(JSON.stringify({ scenario, quiescent: report.stable, ...report }))
          if (report.stable) return
          failures.push(scenario)
          yield* ui.screenshot(`not-quiescent-${scenario}`)
        })

      // Establish a completed exchange first so rehydration has stable rows.
      markers.push("M0X")
      yield* ui.submit("M0X before the restart")
      yield* ui.waitFor("M0X_DONE", { timeout: 30_000 })

      // Kill the service mid-stream: the assistant message for M1X is never
      // finalized. Relaunch and require the transcript to settle anyway.
      markers.push("M1X")
      yield* ui.submit("M1X stream into the restart")
      yield* ui.waitFor("M1X_WORKING", { timeout: 30_000 })
      console.error("probe: killing server mid-stream")
      yield* server.kill()
      console.error("probe: relaunching server")
      yield* server.launch()
      console.error("probe: relaunched, waiting for transcript")
      yield* ui.waitFor("M0X_DONE", { timeout: 60_000 })
      yield* requireQuiescence("restart-mid-stream")
      yield* ui.screenshot("after-restart")

      // The composer must accept new work against the replacement service.
      markers.push("M2X")
      yield* ui.submit("M2X after the restart")
      yield* ui.waitFor("M2X_DONE", { timeout: 60_000 })
      yield* requireQuiescence("post-restart-exchange")

      console.log(JSON.stringify({ scenarios: 2, failures }))
      if (failures.length > 0)
        return yield* Effect.fail(new Error(`UI failed to settle after: ${failures.join(", ")}`))
    }),
})
