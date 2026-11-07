import assert from "node:assert/strict"
import { Deferred, Effect, Stream } from "effect"
import { defineScript, Llm } from "../../../src/index.js"

export default defineScript({
  llm: { settlementTimeout: 2_000 },
  run: ({ artifacts, llm, opencode }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      yield* llm.serve(() =>
        Stream.make(Llm.text("working ")).pipe(
          Stream.concat(
            Stream.fromEffect(Deferred.await(gate)).pipe(
              Stream.flatMap(() => Stream.make(Llm.text("released"))),
            ),
          ),
        ),
      )

      const location = yield* opencode.location.get({
        location: { directory: `${artifacts}/files` },
      })
      const session = yield* opencode.session.create({
        title: "Interrupted LLM settlement",
        location,
      })
      yield* opencode.session.prompt({ sessionID: session.id, text: "wait" })
      yield* Effect.sleep(300)
      yield* opencode.session.interrupt({ sessionID: session.id })

      assert.deepEqual(
        yield* opencode.session.active(),
        {},
        "the interrupted session should no longer be active",
      )
    }),
})
