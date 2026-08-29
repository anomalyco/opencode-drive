import assert from "node:assert/strict"
import { defineScript } from "../../../src/index.js"
import { Effect } from "effect"
import { latestSessionId, serveMarkers, settled } from "./support.js"
import { saveFailure } from "./state-machine.js"

// A refused connection cannot admit input. Rejection must preserve the draft,
// and an explicit resend after healing must admit it exactly once.
export default defineScript({
  network: true,
  run: ({ ui, llm, network, opencode, artifacts }) =>
    Effect.gen(function* () {
      const model = yield* serveMarkers(llm, { title: "Reconnect submission" })
      model.track("FIRST")
      model.track("SECOND")
      const trace: string[] = []
      const checkpoint = (name: string) => {
        trace.push(name)
        console.error(JSON.stringify({ checkpoint: name }))
      }
      yield* Effect.gen(function* () {
        yield* ui.submit("FIRST probe")
        yield* ui.waitFor("FIRST_DONE", { timeout: 20_000 })
        const sessionID = yield* latestSessionId(opencode)
        yield* opencode.session.wait({ sessionID })
        const owners = Effect.all({
          messages: opencode.message.list({ sessionID, limit: 100 }),
          pending: opencode.session.inbox.list({ sessionID }),
        }).pipe(
          Effect.map((result) => ({
            projected: result.messages.data.filter(
              (message) => message.type === "user" && message.text === "SECOND probe",
            ).length,
            pending: result.pending.filter((item) => item.type === "user" && item.payload.text === "SECOND probe")
              .length,
          })),
        )

        checkpoint("refuse-connections-and-show-overlay")
        yield* network.set({ refuseNew: true })
        assert((yield* network.killConnections()) > 0)
        yield* ui.waitFor("Connection lost", { timeout: 10_000 })
        yield* ui.screenshot("reconnect-overlay")
        yield* ui.submit("SECOND probe")
        yield* ui.waitFor("Transport", { timeout: 10_000 })
        assert.deepEqual(yield* owners, { projected: 0, pending: 0 })
        yield* ui.screenshot("reconnect-rejected")

        checkpoint("heal-and-check-restored-composer")
        yield* network.clear()
        yield* ui.waitFor(() => ui.matches("Connection lost").pipe(Effect.map((visible) => !visible)), {
          timeout: 30_000,
        })
        const input = yield* ui.getElement({ focused: true, editor: true })
        const frame = yield* ui.capture()
        const draft = frame.lines
          .slice(input.y, input.y + input.height)
          .map((line) =>
            line.spans
              .map((span) => span.text)
              .join("")
              .slice(input.x, input.x + input.width),
          )
          .join("\n")
        assert(draft.includes("SECOND probe"), "failed input was not restored to the composer")
        assert.deepEqual(
          yield* owners,
          { projected: 0, pending: 0 },
          "input was admitted at the healed observation boundary",
        )
        yield* ui.screenshot("reconnect-draft-restored")

        checkpoint("explicit-resend-converges-once")
        yield* ui.enter()
        yield* ui.waitFor("SECOND_DONE", { timeout: 20_000 })
        yield* opencode.session.wait({ sessionID })
        assert.equal(
          (yield* opencode.session.get({ sessionID })).outcome,
          "succeeded",
          "resend settled without succeeding",
        )
        assert.deepEqual(yield* owners, { projected: 1, pending: 0 })
        assert.equal((yield* opencode.session.inbox.list({ sessionID })).length, 0)
        yield* ui.waitFor((state) => state.focused.editor)
        assert((yield* settled(ui)).stable, "resend left the UI busy")
        yield* ui.screenshot("reconnect-resend-complete")
        console.log(JSON.stringify({ sessionID, trace, passed: true }))
      }).pipe(
        Effect.catchCause((cause) =>
          saveFailure(
            { ui, artifacts, evidence: () => opencode.session.list({ limit: 10 }) },
            { trace, cause: String(cause) },
          ).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
        Effect.ensuring(network.clear().pipe(Effect.orDie)),
      )
    }),
})
