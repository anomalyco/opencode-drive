import { defineScript, Llm } from "../../../src/index.js"
import { Effect, Stream } from "effect"
import { settled } from "./support.js"

// Reproduces the stuck-running tool part: a plugin-controlled tool whose
// transport dies mid-execution (here: drive's tool controller idle timeout)
// fails the tool and the step correctly continues with the failure result —
// but the tool part's failure is never published. The row keeps its spinner
// after the continuation completes, and only an unrelated later drain's
// settleStaleToolCalls sweep settles it.
//
// Run with the drive tool controller idleTimeout temporarily lowered (and its
// /execute `server.timeout(request, 0)` exemption removed) so the transport
// dies in seconds instead of never.
//
//   bun run --cwd packages/drive drive start --name tui-tool-transport-death \
//     --script test/manual/tui-regressions/tool-transport-death.ts \
//     --dev "$OPENCODE_DEV"

export default defineScript({
  tools: ["shell"],
  llm: { settlementTimeout: 180_000 },

  run: ({ ui, llm, tools, opencode }) =>
    Effect.gen(function* () {
      const toolCalled = new Set<string>()
      yield* llm.serve((request) => {
        const body = JSON.stringify(request.body)
        if (body.includes("title generator")) return Stream.make(Llm.text("Tool transport death"))
        if (body.lastIndexOf("T0X") >= 0 && !toolCalled.has("T0X")) {
          toolCalled.add("T0X")
          return Stream.make(
            Llm.toolCall({ index: 0, id: "call_T0X", name: "shell", input: { command: "gauntlet hold" } }),
            Llm.finish("tool-calls"),
          )
        }
        return Stream.make(Llm.text("T0X_CONTINUED"))
      })

      const shells = yield* tools.control("shell")
      yield* ui.submit("T0X hold a silent shell")
      const held = yield* shells.take("call_T0X")
      yield* held.progress("one progress line, then silence\n")

      // Outlive the (lowered) idle timeout without sending bytes; the tool
      // controller kills the connection and the plugin's execute fetch dies.
      yield* held.awaitInterrupted()
      console.error(JSON.stringify({ observed: "transport interruption" }))

      // The step continues with the failure result and completes.
      yield* ui.waitFor("T0X_CONTINUED", { timeout: 30_000 })

      // Now the turn is over. The tool part must be terminal and the UI must
      // settle. No further prompts: nothing may rely on a later drain sweep.
      const report = yield* settled(ui, { deadlineMs: 15_000 })
      const sessions = yield* opencode.session.list({ limit: 1, order: "desc" })
      const sessionID = sessions.data[0]!.id
      const messages = yield* opencode.message.list({ sessionID, limit: 10, order: "desc" })
      const toolStates = messages.data.flatMap((message) =>
        message.type === "assistant"
          ? message.content.flatMap((part) =>
              part.type === "tool"
                ? [
                    {
                      status: part.state?.status,
                      error: part.state?.status === "error" ? part.state.error : undefined,
                    },
                  ]
                : [],
            )
          : [],
      )
      console.log(JSON.stringify({ quiescent: report.stable, unstable: report.unstable, toolStates }))
      yield* ui.screenshot("after-continuation")
      if (!report.stable || toolStates.some((tool) => tool.status === "running"))
        return yield* Effect.fail(
          new Error("tool part left running after its transport died and the step completed"),
        )
    }),
})
