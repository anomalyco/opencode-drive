import { defineScript } from "../../../src/index.js"
import { Effect } from "effect"
import { admissions, appeared, pacedReply, promptHistory, serveMarkers } from "./support.js"

// Probes whether a plain-enter steer submitted mid-stream is ever silently
// dropped (text left in the composer, no admission, no feedback). Runs on a
// CLEAN network: any drop here is a pure TUI lifecycle bug, not chaos.
// (Result: steers are never dropped on a clean network — the drop needs an
// in-flight submit POST; see type-during-submit.ts.)
//
//   bun run --cwd packages/drive drive start --name tui-steer-enter-drop \
//     --script test/manual/tui-regressions/steer-enter-drop.ts \
//     --dev "$OPENCODE_DEV"

const offsets = [0, 300, 700, 1_200, 1_800]

export default defineScript({
  llm: { settlementTimeout: 180_000 },

  run: ({ ui, llm, opencode, artifacts }) =>
    Effect.gen(function* () {
      const model = yield* serveMarkers(llm, {
        title: "Steer drop probe",
        reply: pacedReply,
      })

      const results: Array<{
        offset: number
        steerInHistory: boolean
        admitted: number
        repliedOnScreen: boolean
      }> = []

      for (let index = 0; index < offsets.length; index++) {
        const offset = offsets[index]!
        const first = `A${index}Z`
        const steer = `B${index}Z`
        model.track(first)
        model.track(steer)

        yield* ui.submit(`${first} start the stream`)
        yield* ui.waitFor(`${first}_WORKING`, { timeout: 20_000 })
        yield* Effect.sleep(offset)
        yield* ui.submit(`${steer} steer now`)

        // Let both settle generously, then judge by evidence instead of failing.
        yield* ui.waitFor(`${first}_DONE`, { timeout: 30_000 })
        const repliedOnScreen = yield* appeared(ui, `${steer}_DONE`, { timeout: 20_000 })

        const admitted = yield* admissions(opencode, steer)
        const history = yield* promptHistory(artifacts)
        const steerInHistory = history.some(
          (entry) => entry.text.includes(steer) && !entry.text.includes(first),
        )
        results.push({ offset, steerInHistory, admitted, repliedOnScreen })
        if (!repliedOnScreen) yield* ui.screenshot(`steer-drop-${offset}ms`)

        // Clear any leftover composer text so iterations stay independent.
        // (ctrl+c on an empty composer exits the TUI; ctrl+u kills the line.)
        yield* ui.press("u", { ctrl: true })
      }

      console.log(JSON.stringify({ results }, undefined, 2))
      const dropped = results.filter((entry) => entry.admitted === 0)
      if (dropped.length > 0)
        return yield* Effect.fail(
          new Error(
            `steer enter dropped at offsets: ${dropped.map((entry) => entry.offset).join(", ")}ms`,
          ),
        )
    }),
})
