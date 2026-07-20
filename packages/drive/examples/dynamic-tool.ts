import { Effect, Schema, Stream } from "effect"
import { defineScript, Llm } from "opencode-drive"

const LookupInput = Schema.Struct({ query: Schema.String })

export default defineScript({
  run: ({ tools, llm, ui }) => Effect.gen(function* () {
    yield* tools.attach({
      tools: [
        {
          name: "lookup",
          description: "Look up a numeric value",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { answer: { type: "number" } },
            required: ["answer"],
            additionalProperties: false,
          },
          options: { codemode: false },
        },
      ],
    })

    let turn = 0
    yield* llm.serve(() =>
      turn++ === 0
        ? Stream.make(
            Llm.toolCall({
              index: 0,
              id: "call_lookup",
              name: "lookup",
              input: { query: "meaning" },
            }),
            Llm.finish("tool-calls"),
          )
        : Stream.make(
            Llm.text("The lookup returned 42."),
            Llm.finish("stop"),
          ),
    )

    yield* ui.submit("Look up the meaning and report the result")
    const lookup = yield* tools.take("call_lookup")
    const input = yield* Schema.decodeUnknownEffect(LookupInput)(lookup.input)
    const cancelled = lookup.awaitCancelled().pipe(
      Effect.tap((cancellation) =>
        Effect.log(`lookup cancelled: ${cancellation.reason}`),
      ),
      Effect.as("cancelled" as const),
    )
    const outcome = yield* Effect.raceFirst(
      Effect.gen(function* () {
        yield* lookup.progress({
          structured: { phase: "searching", query: input.query },
          content: [{ type: "text", text: "Searching" }],
        })
        yield* Effect.sleep(250)
        yield* lookup.finish({
          structured: { answer: 42 },
          content: [{ type: "text", text: "42" }],
        })
        yield* Effect.log("lookup completed")
        return "completed" as const
      }).pipe(
        Effect.catch((error) =>
          error.reason === "cancelled" ? cancelled : Effect.fail(error),
        ),
      ),
      cancelled,
    )
    if (outcome === "completed")
      yield* ui.waitFor("The lookup returned 42.")
  }),
})
