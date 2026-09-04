import { defineScript } from "opencode-drive"
import { Effect } from "effect"

// Recording is deliberately inherited from CLI --record, not declared here.
export default defineScript({
  run: ({ artifacts, tui, tuis }) => Effect.gen(function* () {
    const secondary = yield* tuis.launch()
    const rejected = yield* tuis.launch({ pointerOverlay: true }).pipe(Effect.flip)
    yield* Effect.tryPromise(() => Bun.write(`${artifacts}/pointer-options.json`, JSON.stringify({
      primaryRecording: tui.recording !== undefined,
      secondaryRecording: secondary.recording !== undefined,
      rejected: rejected.message,
    })))
  }),
})
