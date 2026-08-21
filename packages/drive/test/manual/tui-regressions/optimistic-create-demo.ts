import { defineScript } from "../../../src/index.js"
import { Effect } from "effect"
import { serveMarkers } from "./support.js"

// Annotated demo recording for opencode PR #43687 (optimistic session
// creation). Runs the identical scenario against the pre-fix baseline and
// the fix branch so the two exported videos differ only in the app's
// behavior:
//
//   1. 600ms of wire latency, type a prompt, enter.
//      - before: home screen freezes for ~1.25s (create + environment
//        round trips) with the text stuck in the composer.
//      - after: session view opens instantly with the prompt row rendered.
//   2. Type a follow-up during the create window and press enter.
//      - before: the text merges into the frozen composer and is destroyed.
//      - after: it lands in the live session composer and submits, gated on
//        the in-flight create.
//
// Marks recorded via tui.recording.mark() become footer labels in the
// exported mp4 (segment label bottom-left, timecode + "drive" bottom-right).
//
//   OPENCODE_DRIVE_MEDIA_DIR=$PWD/.drive-output bun run --cwd packages/drive \
//     drive start --name tui-optimistic-demo \
//     --script test/manual/tui-regressions/optimistic-create-demo.ts \
//     --dev "$OPENCODE_DEV"

export default defineScript({
  network: true,
  tui: { recording: true, viewport: { cols: 100, rows: 30 } },
  llm: { settlementTimeout: 120_000 },

  run: ({ ui, llm, network, tui }) =>
    Effect.gen(function* () {
      const recording = tui.recording
      if (!recording) return yield* Effect.fail(new Error("recording is not enabled"))
      const model = yield* serveMarkers(llm, { title: "Optimistic create demo" })
      model.track("FIRST")
      model.track("SECOND")

      // Let startup catalog loads finish before degrading the network.
      yield* Effect.sleep(1500)
      yield* network.set({ latencyMs: 600 })

      yield* recording.mark("typing a prompt — 600ms wire latency")
      yield* ui.type("FIRST: fix the flaky test in ci.yml")
      yield* Effect.sleep(600)

      yield* recording.mark("enter — session.create on the wire")
      yield* ui.enter()
      yield* Effect.sleep(900)

      yield* recording.mark("typing a follow-up while the create is in flight")
      yield* ui.type("SECOND: also update the README")
      yield* Effect.sleep(400)
      yield* ui.enter()
      yield* Effect.sleep(600)
      yield* network.clear()

      yield* recording.mark("network healed — settling")
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        if ((yield* ui.matches("FIRST_DONE")) || (yield* ui.matches("SECOND_DONE"))) break
        yield* Effect.sleep(200)
      }
      yield* Effect.sleep(2500)
      yield* recording.mark("")
      yield* Effect.sleep(1000)

      const video = yield* recording.finish()
      console.log("video:", video)
    }),
})
