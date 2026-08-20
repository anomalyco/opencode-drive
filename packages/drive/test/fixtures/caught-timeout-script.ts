import { defineScript } from "opencode-drive"
import * as Effect from "effect/Effect"

export default defineScript({
  run: ({ ui }) =>
    Effect.gen(function* () {
      const appeared = yield* Effect.matchEffect(
        ui.waitFor("this text never appears", { timeout: 50 }),
        {
          onFailure: (error) => Effect.succeed(error._tag),
          onSuccess: () => Effect.succeed("matched"),
        },
      )
      console.log(`caught wait timeout: ${appeared}`)
    }),
})
