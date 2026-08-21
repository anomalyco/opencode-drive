import { defineScript } from "../../../src/index.js"
import { Effect } from "effect"
import { admissions, appeared, latestSessionId, promptHistory, serveMarkers } from "./support.js"

// Repro for the submit-await input-destruction race (network-properties seeds
// 1/7/99), updated for optimistic session creation. Pre-fix, the prompt
// component cleared the composer only AFTER the awaited session.create
// resolved: anything typed during that in-flight window was appended to the
// still-visible previous text, its enter dropped, destroyed by the post-await
// input.clear(), and recorded in prompt history as a merged entry that was
// never sent.
//
// With optimistic create, enter navigates immediately: the mid-flight typing
// lands in the live session composer and its enter SUBMITS, gated on the
// in-flight create. Both prompts must be admitted exactly once, in
// submission order. When both are admitted before the run starts, opencode
// batches them into a single turn — the stub then answers with the LAST
// marker only, so the probe accepts either done marker on screen and treats
// server admissions as ground truth.
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

      // Let startup catalog loads finish before degrading the network.
      yield* Effect.sleep(1500)

      // Slow the wire down so the create/submit window is wide open.
      yield* network.set({ latencyMs: 800 })
      yield* ui.submit("FIRST probe")
      // Type the second prompt while the create round trip is in flight.
      yield* Effect.sleep(250)
      yield* ui.screenshot("mid-flight")
      yield* ui.submit("SECOND probe")
      yield* network.clear()

      // Either marker may answer first (single batched turn replies with the
      // last marker only).
      const deadline = Date.now() + 30_000
      let anyReply = false
      while (Date.now() < deadline) {
        if ((yield* ui.matches("FIRST_DONE")) || (yield* ui.matches("SECOND_DONE"))) {
          anyReply = true
          break
        }
        yield* Effect.sleep(100)
      }

      // Legacy pre-fix path: if SECOND was not admitted but its text survived
      // in the composer, a re-press must send it.
      let survivedInComposer = false
      if (anyReply && (yield* admissions(opencode, "SECOND probe")) === 0) {
        survivedInComposer = yield* ui.matches("SECOND probe")
        if (survivedInComposer) {
          yield* ui.enter()
          yield* appeared(ui, "SECOND_DONE")
        }
      }
      yield* ui.screenshot("settled")

      const admittedFirst = yield* admissions(opencode, "FIRST probe")
      const admittedSecond = yield* admissions(opencode, "SECOND probe")
      const sessionID = yield* latestSessionId(opencode)
      const ordered = yield* opencode.message
        .list({ sessionID, limit: 100, order: "asc" })
        .pipe(
          Effect.map((messages) => {
            const texts = messages.data.flatMap((message) => (message.type === "user" ? [message.text] : []))
            const first = texts.findIndex((text) => text.includes("FIRST probe"))
            const second = texts.findIndex((text) => text.includes("SECOND probe"))
            return first !== -1 && second !== -1 && first < second
          }),
        )
      const history = yield* promptHistory(artifacts)
      const mergedHistory = history.some((entry) => entry.text.includes("FIRST") && entry.text.includes("SECOND"))

      const ok = anyReply && admittedFirst === 1 && admittedSecond === 1 && ordered && !mergedHistory
      console.log(
        JSON.stringify({
          anyReply,
          admittedFirst,
          admittedSecond,
          ordered,
          mergedHistory,
          survivedInComposer,
          verdict: ok
            ? "ok: both prompts admitted exactly once, in order"
            : admittedSecond === 0
              ? "REPRO: second prompt destroyed by post-await input.clear()"
              : "FAIL: admissions out of order or duplicated",
        }),
      )
      if (!ok) return yield* Effect.fail(new Error("typed-during-submit contract violated"))
    }),
})
