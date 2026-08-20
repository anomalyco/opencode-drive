import { defineScript } from "../../../src/index.js"
import { Effect } from "effect"
import { admissions, appeared, promptHistory, serveMarkers } from "./support.js"

// Distilled from network-properties seed 1 (steps 7-9): blackhole the
// network, heal it, then submit immediately. Classifies whether the submit is
// admitted, rejected, or swallowed. (Result: this shape alone does NOT drop
// the prompt — the real culprit is the type-during-submit race.)
//
//   OPENCODE_DRIVE_HEAL_DELAY=0 OPENCODE_DRIVE_STALL_MS=2500 \
//     bun run --cwd packages/drive drive start --name tui-heal-submit-drop \
//     --script test/manual/tui-regressions/heal-submit-drop.ts \
//     --dev "$OPENCODE_DEV"

const healDelay = Number(process.env.OPENCODE_DRIVE_HEAL_DELAY ?? "0")
const stallMs = Number(process.env.OPENCODE_DRIVE_STALL_MS ?? "2500")

export default defineScript({
  network: true,
  llm: { settlementTimeout: 120_000 },

  run: ({ ui, llm, network, opencode, artifacts }) =>
    Effect.gen(function* () {
      const model = yield* serveMarkers(llm, { title: "Heal submit drop probe" })
      model.track("FIRST")
      model.track("SECOND")

      // Healthy baseline.
      yield* ui.submit("FIRST probe")
      yield* ui.waitFor("FIRST_DONE", { timeout: 20_000 })

      // The seed-1 shape: a quiet blackhole window, then heal, then submit.
      yield* network.set({ blackhole: true })
      yield* Effect.sleep(stallMs)
      yield* network.clear()
      yield* Effect.sleep(healDelay)

      yield* ui.screenshot("pre-submit")
      yield* ui.submit("SECOND probe")
      yield* Effect.sleep(1_500)
      yield* ui.screenshot("post-submit")

      const replied = yield* appeared(ui, "SECOND_DONE", { timeout: 20_000 })
      const admitted = yield* admissions(opencode, "SECOND")
      const history = yield* promptHistory(artifacts)
      const inHistory = history.some((entry) => entry.text.includes("SECOND"))

      console.log(
        JSON.stringify({
          healDelay,
          stallMs,
          admitted,
          replied,
          inHistory,
          verdict:
            admitted === 1 && replied
              ? "ok: admitted and replied"
              : admitted === 1
                ? "admitted but reply missing on screen"
                : inHistory
                  ? "submitted client-side but never admitted"
                  : "enter swallowed: no history entry, no admission",
        }),
      )
      if (admitted !== 1 || !replied) return yield* Effect.fail(new Error("drop reproduced"))
    }),
})
