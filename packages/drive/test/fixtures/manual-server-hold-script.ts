import { Effect } from "effect"
import { defineScript } from "../../src/index.js"

export default defineScript({
  launch: "manual",
  run: ({ server }) =>
    Effect.gen(function* () {
      yield* server.launch()
      yield* Effect.never
    }),
})
