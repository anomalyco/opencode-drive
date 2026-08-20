import { defineScript, Llm } from "../../../src/index.js"
import { Effect, Stream } from "effect"

// Demo recording for the session resize-listener fix: fill the transcript
// with several assistant replies (each renders an AssistantFooter reading the
// shared terminal size), then sweep the terminal across widths that cross the
// footer's 28- and 36-column breakpoints, and finish with a prompt submitted
// at a narrow width. The footer must adapt at every width and the run must
// emit zero MaxListeners warnings (check the TUI stderr log afterwards).
//
//   OPENCODE_DRIVE_MEDIA_DIR=... bun run --cwd packages/drive drive start \
//     --name tui-resize-storm \
//     --script test/manual/tui-regressions/resize-storm.ts \
//     --dev /Users/kit/code/open-source/opencode-tui-fixes

export default defineScript({
  tui: { recording: true, viewport: { cols: 100, rows: 32 } },
  llm: { settlementTimeout: 120_000 },

  run: ({ ui, llm }) =>
    Effect.gen(function* () {
      const markers: Array<string> = []
      yield* llm.serve((request) => {
        const body = JSON.stringify(request.body)
        if (body.includes("title generator")) return Stream.make(Llm.text("Resize storm"))
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
          Llm.text(`${marker}_REPLY: the assistant footer under this message reads the `),
          Llm.pause(250),
          Llm.text(`shared terminal size from the session context. ${marker}_DONE`),
        )
      })

      for (const marker of ["R0X", "R1X", "R2X", "R3X"]) {
        markers.push(marker)
        yield* ui.submit(`${marker} render a reply with a footer`)
        yield* ui.waitFor(`${marker}_DONE`, { timeout: 30_000 })
      }
      yield* Effect.sleep(700)

      // Sweep across the footer's 28/36-column breakpoints in both directions.
      for (const cols of [80, 60, 44, 34, 27, 24, 30, 40, 70, 100]) {
        yield* ui.resize({ cols, rows: 32 })
        yield* Effect.sleep(550)
      }

      // Prove the composer still works at a narrow width and after widening.
      yield* ui.resize({ cols: 44, rows: 32 })
      markers.push("R4X")
      yield* ui.submit("R4X reply at a narrow width")
      yield* ui.waitFor("R4X_DONE", { timeout: 30_000 })
      yield* Effect.sleep(500)
      yield* ui.resize({ cols: 100, rows: 32 })
      yield* Effect.sleep(1_000)
    }),
})
