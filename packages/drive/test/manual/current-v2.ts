import assert from "node:assert/strict"
import { Effect, Option, Queue, Stream } from "effect"
import { Llm, OpenCodeDriver } from "opencode-drive"

// Run through `drive run` with OPENCODE_DRIVE_DEV pointing to an installed V2 checkout.
const dev = process.env.OPENCODE_DRIVE_DEV
if (dev === undefined) throw new Error("OPENCODE_DRIVE_DEV must point to an isolated V2 checkout")

export default OpenCodeDriver.useReport(
  {
    opencode: { dev, compatibility: "required" },
    config: { autoupdate: false },
    tools: ["shell"],
    tui: { viewport: { cols: 100, rows: 35 } },
  },
  ({ llm, ui, opencode, tools }) =>
    Effect.gen(function* () {
      yield* llm.title(() => Effect.succeed("Drive compatibility"))
      yield* llm.queue(Llm.text("QUEUED_REPLY_OK", { delay: 0 }))
      yield* ui.waitFor((state) => state.focused.editor)
      yield* ui.submit("Reply to the fixture prompt")
      yield* ui.waitFor("QUEUED_REPLY_OK")

      const sessionID = (yield* opencode.session.list({ limit: 1, order: "desc" })).data[0]?.id
      assert(sessionID)
      const messages = yield* opencode.message.list({ sessionID, limit: 20 })
      assert(messages.data.some((message) => message.type === "user" && message.text === "Reply to the fixture prompt"))
      assert.deepEqual(yield* opencode.session.inbox.list({ sessionID }), [])

      const events = yield* opencode.event.subscribe().pipe(Stream.toQueue({ capacity: "unbounded" }))
      assert.equal((yield* Queue.take(events)).type, "server.connected")
      const progress = (id: string) =>
        Stream.fromQueue(events).pipe(
          Stream.filter((event) => event.type === "session.tool.progress"),
          Stream.filter((event) => event.data.sessionID === sessionID && event.data.id === id),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.timeout("5 seconds"),
        )

      const shells = yield* tools.control("shell")
      yield* llm.queue(
        Llm.toolCall({ index: 0, id: "call_shell", name: "shell", input: { command: "fixture-only" } }, { delay: 0 }),
        Llm.finish("tool-calls"),
      )
      yield* llm.queue(Llm.text("SHELL_REPLY_OK", { delay: 0 }))
      yield* ui.submit("Run the controlled shell")
      const shell = yield* shells.take("call_shell")
      yield* shell.progress("SHELL_PROGRESS_OK")
      assert.deepEqual((yield* progress("call_shell")).data.metadata, { output: "SHELL_PROGRESS_OK" })
      yield* shell.succeed({ output: "SHELL_OUTPUT_OK", exit: 0 })
      yield* ui.waitFor("SHELL_REPLY_OK")

      yield* tools.attach({
        tools: [
          {
            name: "lookup",
            description: "Look up the fixture",
            inputSchema: { type: "object", properties: {} },
            options: { codemode: false },
          },
        ],
      })
      yield* llm.queue(
        Llm.toolCall({ index: 0, id: "call_lookup", name: "lookup", input: {} }, { delay: 0 }),
        Llm.finish("tool-calls"),
      )
      yield* llm.queue(Llm.text("DYNAMIC_REPLY_OK", { delay: 0 }))
      yield* ui.submit("Look up the fixture")
      const lookup = yield* tools.take("call_lookup")
      assert.equal(lookup.context.id, "call_lookup")
      yield* lookup.progress({ phase: "searching", output: "DYNAMIC_PROGRESS_OK" })
      assert.deepEqual((yield* progress("call_lookup")).data.metadata, {
        phase: "searching",
        output: "DYNAMIC_PROGRESS_OK",
      })
      yield* lookup.finish({ structured: null, content: [{ type: "text", text: "DYNAMIC_OUTPUT_OK" }] })
      yield* ui.waitFor("DYNAMIC_REPLY_OK")
      yield* opencode.session.wait({ sessionID })
      yield* ui.waitFor(() =>
        opencode.session.get({ sessionID }).pipe(Effect.map((session) => session.title === "Drive compatibility")),
      )

      const frame = yield* ui.capture()
      assert.equal(frame.cols, 100)
      assert.equal(frame.rows, 35)
      yield* ui.screenshot("current-v2")
    }),
).pipe(
  Effect.tap(({ report }) =>
    Effect.sync(() => {
      assert(report.compatibility.every((endpoint) => endpoint._tag === "Negotiated"))
      console.log(JSON.stringify(report, undefined, 2))
    }),
  ),
  Effect.timeout("90 seconds"),
)
