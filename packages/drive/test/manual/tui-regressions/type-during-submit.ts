import { defineScript } from "../../../src/index.js"
import { Effect } from "effect"
import { admissions, appeared, promptHistory, serveMarkers } from "./support.js"

// Repro for the submit-await input-destruction race (network-properties seeds
// 1/7/99). The prompt component clears the composer only AFTER the awaited
// session.prompt POST resolves. Anything typed during that in-flight window:
//   - is appended to the still-visible previous text,
//   - has its enter dropped,
//   - is destroyed by the post-await input.clear(),
//   - and is recorded in prompt history as a merged entry that was never sent.
//
//   bun run --cwd packages/drive drive start --name tui-type-during-submit \
//     --script test/manual/tui-regressions/type-during-submit.ts \
//     --dev "$OPENCODE_DEV"

export default defineScript({
  network: true,
  llm: { settlementTimeout: 120_000 },

  run: ({ ui, llm, network, opencode, artifacts }) =>
    Effect.gen(function* () {
      const model = yield* serveMarkers(llm, { title: "Type during submit probe" })
      model.track("FIRST")
      model.track("SECOND")

      // Slow the POST down so the submit handler's await window is wide open.
      yield* network.set({ latencyMs: 800 })
      yield* ui.submit("FIRST probe")
      // Type the second prompt while the first POST is still in flight.
      yield* Effect.sleep(250)
      yield* ui.screenshot("mid-flight")
      yield* ui.submit("SECOND probe")
      yield* network.clear()

      yield* ui.waitFor("FIRST_DONE", { timeout: 30_000 })
      const replied = yield* appeared(ui, "SECOND_DONE")
      yield* ui.screenshot("settled")

      const admitted = yield* admissions(opencode, "SECOND")
      const history = yield* promptHistory(artifacts)
      const mergedHistory = history.some(
        (entry) => entry.text.includes("FIRST") && entry.text.includes("SECOND"),
      )

      console.log(
        JSON.stringify({
          admitted,
          replied,
          mergedHistory,
          verdict:
            admitted === 0
              ? "REPRO: second prompt destroyed by post-await input.clear()"
              : "ok: second prompt survived",
        }),
      )
      if (admitted !== 1 || !replied)
        return yield* Effect.fail(new Error("typed-during-submit prompt was lost"))
    }),
})
