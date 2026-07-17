import { Effect } from "effect"
import { Llm } from "opencode-drive"
import type { Driver } from "opencode-drive/driver"

export type PatchSuccessCheckpoint =
  | "patch-input-streaming"
  | "permission-prompt"
  | "patch-success"

export function capturePatchSuccess(
  driver: Driver,
  checkpoint: (id: PatchSuccessCheckpoint) => Effect.Effect<void, unknown, never>,
) {
  return Effect.gen(function* () {
    yield* driver.llm.queue(
      Llm.toolCall(
        {
          index: 0,
          id: "call_patch_success",
          name: "patch",
          input: {
            patchText: [
              "*** Begin Patch",
              "*** Update File: fixture.txt",
              "@@",
              "-before",
              "+after",
              "*** End Patch",
            ].join("\n"),
          },
        },
        { delay: 90, chunkSize: 8 },
      ),
      Llm.finish("tool-calls"),
    )
    yield* driver.llm.queue(Llm.text("The fixture was updated."))
    yield* driver.ui.submit("Change fixture.txt from before to after.")
    yield* Effect.sleep(450)
    yield* checkpoint("patch-input-streaming")
    yield* driver.ui.waitFor("Permission required", { timeout: 15_000 })
    yield* checkpoint("permission-prompt")
    yield* driver.ui.enter()
    yield* driver.ui.waitFor("The fixture was updated.", { timeout: 15_000 })
    yield* checkpoint("patch-success")
  })
}
