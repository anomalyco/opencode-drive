import { defineScript, Llm } from "../../../src/index.js"
import { Effect, Stream } from "effect"

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
      yield* llm.serve((request) => {
        const body = JSON.stringify(request.body)
        if (body.includes("title generator"))
          return Stream.make(Llm.text("Type during submit probe"))
        if (body.lastIndexOf("SECOND") > body.lastIndexOf("FIRST"))
          return Stream.make(Llm.text("SECOND_DONE"))
        if (body.includes("FIRST")) return Stream.make(Llm.text("FIRST_DONE"))
        return Stream.make(Llm.text("UNMATCHED"))
      })

      // Slow the POST down so the submit handler's await window is wide open.
      yield* network.set({ latencyMs: 800 })
      yield* ui.submit("FIRST probe")
      // Type the second prompt while the first POST is still in flight.
      yield* Effect.sleep(250)
      yield* ui.screenshot("mid-flight")
      yield* ui.submit("SECOND probe")
      yield* network.clear()

      yield* ui.waitFor("FIRST_DONE", { timeout: 30_000 })
      // waitFor timeouts are run-fatal in drive; poll matches for the optional check.
      let replied = false
      for (let index = 0; index < 30 && !replied; index++) {
        replied = yield* ui.matches("SECOND_DONE")
        if (!replied) yield* Effect.sleep(500)
      }
      yield* ui.screenshot("settled")

      const sessions = yield* opencode.session.list({ limit: 1, order: "desc" })
      const sessionID = sessions.data[0]?.id
      if (sessionID === undefined) return yield* Effect.fail(new Error("no session"))
      const messages = yield* opencode.message.list({ sessionID, limit: 50, order: "desc" })
      const admitted = messages.data.filter(
        (message) => message.type === "user" && message.text.includes("SECOND"),
      ).length
      const history = yield* Effect.promise(() =>
        Bun.file(`${artifacts}/home/.local/state/opencode/prompt-history.jsonl`)
          .text()
          .catch(() => ""),
      )
      const mergedHistory = history
        .split("\n")
        .some((line) => line.includes("FIRST") && line.includes("SECOND"))

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
