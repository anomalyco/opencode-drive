import { Effect, Stream } from "effect"
import { defineScript, Llm } from "../../src/index.js"
import type { ScriptContext } from "../../src/script/types.js"
import pending from "./tui-regressions/pending-form-restart.js"
import reconnect from "./tui-regressions/reconnect-modal-submit.js"

// Expected failure: run the actual recovery/resend probes, but make their
// model emit the visible completion marker followed by a terminal filter.
// Idleness and a stable screen must not let this become a passing probe.
const scenario = process.env.OPENCODE_DRIVE_GUARD_CASE ?? "form"
if (scenario !== "form" && scenario !== "reconnect") throw new Error("unknown guard case")

export default scenario === "form"
  ? defineScript({
      ...pending,
      run: (context) =>
        pending.run({ ...context, llm: failAfterMarker(context.llm, "restart-form-recovery-complete") }),
    })
  : defineScript({
      ...reconnect,
      run: (context) => reconnect.run({ ...context, llm: failAfterMarker(context.llm, "SECOND_DONE") }),
    })

function failAfterMarker(llm: ScriptContext["llm"], marker: string): ScriptContext["llm"] {
  return {
    ...llm,
    serve: (handler) =>
      llm.serve((request, index) => {
        let emitted = false
        return handler(request, index).pipe(
          Stream.tap((output) =>
            Effect.sync(() => {
              if (output.type === "text" && output.text === marker) emitted = true
            }),
          ),
          Stream.concat(
            Stream.unwrap(Effect.sync(() => (emitted ? Stream.make(Llm.finish("content-filter")) : Stream.empty))),
          ),
        )
      }),
  }
}
