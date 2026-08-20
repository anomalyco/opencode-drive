import { defineScript, Llm } from "../../../src/index.js"
import { Effect, Stream } from "effect"
import { settled } from "./support.js"

// Tool-state quiescence: a running shell tool keeps a spinner alive by
// design; once the run is interrupted or the tool settles, every indicator
// must stop. Covers escape-interrupt during tool execution and a connection
// kill under a running tool followed by settlement and continuation.
//
//   bun run --cwd packages/drive drive start --name tui-quiescence-tools \
//     --script test/manual/tui-regressions/quiescence-tools.ts \
//     --dev "$OPENCODE_DEV"

export default defineScript({
  network: true,
  tools: ["shell"],
  llm: { settlementTimeout: 180_000 },

  run: ({ ui, llm, network, tools, opencode, artifacts }) =>
    Effect.gen(function* () {
      const markers: Array<string> = []
      const toolCalled = new Set<string>()
      yield* llm.serve((request) => {
        const body = JSON.stringify(request.body)
        if (body.includes("title generator")) return Stream.make(Llm.text("Quiescence tools probe"))
        let marker: string | undefined
        let position = -1
        for (const candidate of markers) {
          const index = body.lastIndexOf(candidate)
          if (index > position) {
            position = index
            marker = candidate
          }
        }
        if (marker === undefined) return Stream.make(Llm.text("GAUNTLET_UNMATCHED_PROMPT"))
        if (!toolCalled.has(marker)) {
          toolCalled.add(marker)
          return Stream.make(
            Llm.toolCall({
              index: 0,
              id: `call_${marker}`,
              name: "shell",
              input: { command: `gauntlet ${marker}` },
            }),
            Llm.finish("tool-calls"),
          )
        }
        return Stream.make(Llm.text(`${marker}_DONE`))
      })

      const shells = yield* tools.control("shell")
      const failures: Array<string> = []
      const dumpProjection = (scenario: string) =>
        Effect.gen(function* () {
          const sessions = yield* opencode.session.list({ limit: 1, order: "desc" })
          const sessionID = sessions.data[0]?.id
          if (sessionID === undefined) return
          const messages = yield* opencode.message.list({ sessionID, limit: 20, order: "desc" })
          const projection = messages.data.map((message) => ({
            type: message.type,
            ...(message.type === "assistant"
              ? {
                  error: message.error?.message,
                  parts: message.content.map((part) =>
                    part.type === "tool"
                      ? {
                          tool: part.name,
                          status: part.state?.status,
                          error: part.state?.status === "error" ? part.state.error : undefined,
                        }
                      : { type: part.type },
                  ),
                }
              : message.type === "user"
                ? { text: message.text.slice(0, 40) }
                : {}),
          }))
          console.error(JSON.stringify({ scenario, projection }))
        }).pipe(Effect.ignore)
      const requireQuiescence = (scenario: string) =>
        Effect.gen(function* () {
          const report = yield* settled(ui)
          console.error(JSON.stringify({ scenario, quiescent: report.stable, ...report }))
          yield* dumpProjection(scenario)
          if (report.stable) return
          failures.push(scenario)
          yield* ui.screenshot(`not-quiescent-${scenario}`)
        })

      // A. Escape while the tool is running: the step aborts, the tool part
      // must settle as aborted, and nothing may keep spinning.
      markers.push("T0X")
      yield* ui.submit("T0X hold a shell open")
      const held = yield* shells.take("call_T0X")
      yield* held.progress("tool running, indicator alive\n")
      yield* Effect.sleep(800)
      // Interrupt is armed on the first escape and fired on the second (within 5s).
      yield* ui.press("escape")
      yield* Effect.sleep(200)
      yield* ui.press("escape")
      yield* held.awaitInterrupted()
      yield* ui.waitFor((state) => state.focused.editor, { timeout: 15_000 })
      yield* requireQuiescence("tool-escape-interrupt")

      // B. Kill every connection while a tool runs, let the TUI reconnect,
      // then settle the tool and require the continuation to converge.
      markers.push("T1X")
      yield* ui.submit("T1X survive a connection kill")
      const survivor = yield* shells.take("call_T1X")
      yield* survivor.progress("still running through the kill\n")
      yield* network.killConnections()
      yield* Effect.sleep(2_000)
      yield* survivor.succeed({ output: "survived\n", exit: 0 })
      yield* ui.waitFor("T1X_DONE", { timeout: 60_000 })
      yield* requireQuiescence("tool-kill-reconnect")

      console.log(JSON.stringify({ scenarios: 2, failures }))
      if (failures.length > 0)
        return yield* Effect.fail(new Error(`UI failed to settle after: ${failures.join(", ")}`))
    }),
})
