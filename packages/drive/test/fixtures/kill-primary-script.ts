import { defineScript } from "opencode-drive"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"

export default defineScript({
  run: ({ client, ui }) =>
    Effect.gen(function* () {
      yield* client.close()
      const closed = Exit.isFailure(yield* Effect.exit(ui.state()))
      if (!closed)
        yield* Effect.fail(
          new Error("primary client remained connected after client.close()"),
        )
    }),
})
