import { Llm, OpenCodeDriver } from "opencode-drive"
import assert from "node:assert/strict"
import { Effect, Option, Queue, Stream } from "effect"
import { makeTransport } from "../../tool/transport.js"
import { latestSessionId, serveMarkers, settled } from "./support.js"

// Drop the real static tool HTTP connection after progress has reached Core.
// The fixture uses Drive's existing TCP proxy without changing production idle
// timeouts, the public tool API, or the TUI's connection to Core.
//
//   OPENCODE_DEV=/path/to/opencode OPENCODE_DRIVE_MEDIA_DIR=$PWD/.drive-output \
//     bun run --cwd packages/drive drive run \
//     test/manual/tui-regressions/tool-transport-death.ts

export default Effect.gen(function* () {
  const dev = process.env.OPENCODE_DEV
  if (!dev) return yield* Effect.die(new Error("OPENCODE_DEV is required for the transport-death probe"))
  const { config, proxy, shells } = yield* makeTransport()
  return yield* OpenCodeDriver.use(
    {
      config,
      opencode: { dev },
      keepArtifacts: true,
      llm: { settlementTimeout: 15_000 },
    },
    ({ ui, llm, opencode, artifacts }) =>
      Effect.gen(function* () {
        console.error(JSON.stringify({ observed: "runtime ready", artifacts }))
        let called = false
        const markers = yield* serveMarkers(llm, {
          title: "Tool transport death",
          reply: (marker) => {
            if (called) return Stream.make(Llm.text(`${marker}_CONTINUED`))
            called = true
            return Stream.make(
              Llm.toolCall({ index: 0, id: "call_T0X", name: "shell", input: { command: "gauntlet hold" } }),
              Llm.finish("tool-calls"),
            )
          },
        })
        const events = yield* opencode.event.subscribe().pipe(Stream.toQueue({ capacity: "unbounded" }))
        assert.equal((yield* Queue.take(events).pipe(Effect.timeout("10 seconds"))).type, "server.connected")
        markers.track("T0X")
        yield* ui.submit("T0X hold a silent shell")
        const held = yield* shells.take("call_T0X").pipe(Effect.timeout("10 seconds"))
        console.error(JSON.stringify({ observed: "tool held", id: held.id, connections: proxy.connections() }))
        const progress = "one progress line, then silence\n"
        yield* held.progress(progress)
        console.error(JSON.stringify({ observed: "progress sent" }))
        const sessionID = yield* latestSessionId(opencode)
        // Running progress is ephemeral, absent from message.list. Establish the
        // live subscription before sending progress so this event cannot be missed.
        const received = yield* Stream.fromQueue(events).pipe(
          Stream.filter((event) => event.type === "session.tool.progress"),
          Stream.filter((event) => event.data.sessionID === sessionID && event.data.id === held.id),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.timeout("10 seconds"),
        )
        assert.deepEqual(received.data.metadata, { output: progress })
        console.error(JSON.stringify({ observed: "Core progress received", metadata: received.data.metadata }))

        const droppedAt = performance.now()
        const killed = yield* Effect.sync(() => proxy.killConnections())
        if (killed !== 1) return yield* Effect.fail(new Error(`expected one active tool connection, dropped ${killed}`))
        yield* held.awaitInterrupted().pipe(Effect.timeout("1 second"))
        const notifiedMs = performance.now() - droppedAt
        const late = yield* held.succeed({ output: "late result" }).pipe(Effect.flip)
        if (late.reason !== "transport-interrupted") return yield* Effect.fail(late)
        console.error(JSON.stringify({ observed: "transport interruption", killed, notifiedMs }))

        // No further prompts: a later drain must not be needed to settle the part.
        yield* ui.waitFor("T0X_CONTINUED", { timeout: 15_000 })
        const report = yield* settled(ui, { deadlineMs: 10_000 })
        const messages = yield* opencode.message.list({ sessionID, limit: 10, order: "desc" })
        const toolStates = messages.data.flatMap((message) =>
          message.type === "assistant"
            ? message.content.flatMap((part) =>
                part.type === "tool" && part.name === "shell"
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
        const screenshot = yield* ui.screenshot("after-continuation")
        console.log(
          JSON.stringify({
            quiescent: report.stable,
            waitedMs: report.waitedMs,
            unstable: report.unstable,
            toolStates,
            screenshot,
          }),
        )
        if (!report.stable || toolStates.length !== 1 || toolStates[0]?.status !== "error" || !toolStates[0].error)
          return yield* Effect.fail(
            new Error("expected one failed tool part and a stable continuation after transport death"),
          )
      }),
  )
}).pipe(Effect.scoped)
