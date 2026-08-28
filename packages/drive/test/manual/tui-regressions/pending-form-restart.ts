import assert from "node:assert/strict"
import { defineScript, Llm } from "../../../src/index.js"
import { Effect, Stream } from "effect"
import { latestSessionId, settled } from "./support.js"
import { saveFailure } from "./state-machine.js"

const question = {
  question: "Which runtime should the restart regression use?",
  header: "Runtime",
  options: [
    { label: "Bun", description: "Use Bun for the regression." },
    { label: "Node", description: "Use Node for the regression." },
  ],
  multiple: false,
}
const recovered = "restart-form-recovery-complete"

export default defineScript({
  launch: "manual",
  run: ({ server, tuis, llm, artifacts }) =>
    Effect.gen(function* () {
      assert(
        process.env.OPENCODE_DRIVE_DB && process.env.OPENCODE_DRIVE_DB !== ":memory:",
        "pending-form-restart requires OPENCODE_DRIVE_DB for durable recovery",
      )
      const opencode = yield* server.launch()
      const tui = yield* tuis.launch("pending-form-restart")
      const trace: string[] = []
      let requests = 0
      yield* llm.serve((request) => {
        if (JSON.stringify(request.body).includes("title generator")) return Stream.make(Llm.text("Form restart"))
        requests++
        return requests === 1
          ? Stream.make(
              Llm.toolCall({
                index: 0,
                id: "call_pending_form_restart",
                name: "question",
                input: { questions: [question] },
              }),
              Llm.finish("tool-calls"),
            )
          : Stream.make(Llm.text(recovered))
      })
      const checkpoint = (name: string) => {
        trace.push(name)
        console.error(JSON.stringify({ checkpoint: name }))
      }
      yield* Effect.gen(function* () {
        yield* tui.ui.submit("Ask one runtime question and wait for my answer.")
        yield* tui.ui.waitFor(question.question, { timeout: 15_000 })
        const sessionID = yield* latestSessionId(opencode)
        assert.equal((yield* opencode.form.list({ sessionID })).length, 1)
        checkpoint("open-form-before-restart")
        yield* tui.ui.screenshot("pending-form-before-restart")

        yield* server.kill()
        const resumed = yield* server.launch()
        // Form state is process-local; recovery aborts the old tool and makes a new model request.
        checkpoint("serve-durable-recovery")
        yield* tui.ui.waitFor(recovered, { timeout: 30_000 })
        yield* resumed.session.wait({ sessionID })
        assert.equal(
          (yield* resumed.session.get({ sessionID })).outcome,
          "succeeded",
          "recovery settled without succeeding",
        )
        assert.equal((yield* resumed.form.list({ sessionID })).length, 0, "stale form stayed open")
        assert(!(yield* tui.ui.matches("Form not found")), "stale form accepted local interaction")
        yield* tui.ui.waitFor((state) => state.focused.editor, { timeout: 10_000 })
        assert((yield* settled(tui.ui)).stable, "recovered UI did not settle")

        const messages = (yield* resumed.message.list({ sessionID, limit: 100 })).data
        assert(
          messages.some(
            (message) =>
              message.type === "assistant" &&
              message.content.some((part) => part.type === "text" && part.text === recovered),
          ),
          "recovery output was not durably preserved",
        )
        assert.equal(
          messages.filter((message) => message.type === "user").length,
          1,
          "recovery required another user admission",
        )
        assert(
          messages.some((message) => message.type === "synthetic" && message.text.includes("The server restarted")),
          "durable recovery continuation is missing",
        )
        const tool = messages
          .flatMap((message) => (message.type === "assistant" ? message.content : []))
          .find((part) => part.type === "tool" && part.id === "call_pending_form_restart")
        assert(
          tool?.type === "tool" && tool.state.status === "error" && tool.state.error.type === "aborted",
          "old question did not settle as interrupted",
        )
        assert.equal(requests, 2, "fixture did not serve exactly the original request and its recovery")
        checkpoint("verified-stale-form-dismissal-and-recovery")
        yield* tui.ui.screenshot("pending-form-recovered")
        console.log(JSON.stringify({ sessionID, requests, trace, passed: true }))
      }).pipe(
        Effect.catchCause((cause) =>
          saveFailure(
            {
              ui: tui.ui,
              artifacts,
              evidence: () =>
                latestSessionId(opencode).pipe(
                  Effect.flatMap((sessionID) => opencode.message.list({ sessionID, limit: 100 })),
                ),
            },
            { trace, requests, cause: String(cause) },
          ).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
      )
    }),
})
