import { defineScript, Llm } from "../../../src/index.js"
import { Effect, Stream } from "effect"

// Classifies what happens to a prompt submitted while the TUI shows its
// reconnect overlay during a network partition. Distinguishes:
//   A. POST admitted (buffered by the partition, flushed on heal) — reply lands.
//   B. POST rejected — prompt rolls back and its text is restored to the composer.
//   C. Enter swallowed — no POST, text stays in the composer, nothing happens
//      after heal until a second enter.
//
//   bun run --cwd packages/drive drive start --name tui-reconnect-modal-submit \
//     --script test/manual/tui-regressions/reconnect-modal-submit.ts \
//     --dev "$OPENCODE_DEV"

export default defineScript({
  network: true,
  llm: { settlementTimeout: 120_000 },

  run: ({ ui, llm, network, opencode }) =>
    Effect.gen(function* () {
      yield* llm.serve((request) => {
        const body = JSON.stringify(request.body)
        if (body.includes("title generator"))
          return Stream.make(Llm.text("Reconnect modal probe"))
        if (body.lastIndexOf("SECOND") > body.lastIndexOf("FIRST"))
          return Stream.make(Llm.text("SECOND_DONE"))
        if (body.includes("FIRST")) return Stream.make(Llm.text("FIRST_DONE"))
        return Stream.make(Llm.text("UNMATCHED"))
      })

      // Establish the session on a healthy network.
      yield* ui.submit("FIRST probe")
      yield* ui.waitFor("FIRST_DONE", { timeout: 20_000 })

      // Partition, wait for the reconnect overlay, then submit into it.
      yield* network.set({ blackhole: true })
      yield* ui.waitFor("Restarting service", { timeout: 30_000 })
      yield* ui.screenshot("modal-up")
      yield* ui.submit("SECOND probe")
      yield* Effect.sleep(1_500)
      yield* ui.screenshot("modal-after-submit")

      yield* network.clear()
      yield* Effect.sleep(8_000)
      yield* ui.screenshot("healed")

      const sessions = yield* opencode.session.list({ limit: 1, order: "desc" })
      const sessionID = sessions.data[0]?.id
      if (sessionID === undefined) return yield* Effect.fail(new Error("no session"))
      const messages = yield* opencode.message.list({ sessionID, limit: 50, order: "desc" })
      const admitted = messages.data.filter(
        (message) => message.type === "user" && message.text.includes("SECOND"),
      ).length
      const replied = yield* ui.matches("SECOND_DONE")
      console.log(
        JSON.stringify({
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
