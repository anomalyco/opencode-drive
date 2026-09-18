import { defineScript } from "opencode-drive"
import * as Effect from "effect/Effect"

export default defineScript({
  run: () => Effect.fail(new Error("", { cause: new Error("schema mismatch") })),
})
