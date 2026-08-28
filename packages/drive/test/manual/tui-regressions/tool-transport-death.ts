import { Llm, OpenCodeDriver } from "opencode-drive"
import { Effect, Schedule, Stream } from "effect"
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
  return yield* OpenCodeDriver.use({
    config,
    opencode: { dev },
    keepArtifacts: true,
    llm: { settlementTimeout: 15_000 },
  }, ({ ui, llm, opencode }) => Effect.gen(function* () {
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
    markers.track("T0X")
    yield* ui.submit("T0X hold a silent shell")
    const held = yield* shells.take("call_T0X").pipe(Effect.timeout("10 seconds"))
    const progress = "one progress line, then silence\n"
    yield* held.progress(progress)
    const sessionID = yield* latestSessionId(opencode)
    // V2 hides running tool content; the projection proves Core consumed the
    // progress frame before the socket is dropped.
    yield* opencode.message.list({ sessionID, limit: 10, order: "desc" }).pipe(
      Effect.map((messages) => messages.data.some((message) =>
        message.type === "assistant" && message.content.some((part) =>
          part.type === "tool" && part.name === "shell" && part.state.status === "running" &&
          part.state.metadata?.output === progress,
        ),
      )),
      Effect.repeat({ until: (received) => received, schedule: Schedule.spaced("25 millis") }),
      Effect.timeout("10 seconds"),
    )

    const killed = yield* Effect.sync(() => proxy.killConnections())
    if (killed !== 1)
      return yield* Effect.fail(new Error(`expected one active tool connection, dropped ${killed}`))
    yield* held.awaitInterrupted().pipe(Effect.timeout("1 second"))
    const late = yield* held.succeed({ output: "late result" }).pipe(Effect.flip)
    if (late.reason !== "transport-interrupted") return yield* Effect.fail(late)
    console.error(JSON.stringify({ observed: "transport interruption", killed }))

    // No further prompts: a later drain must not be needed to settle the part.
    yield* ui.waitFor("T0X_CONTINUED", { timeout: 15_000 })
    const report = yield* settled(ui, { deadlineMs: 10_000 })
    const messages = yield* opencode.message.list({ sessionID, limit: 10, order: "desc" })
    const toolStates = messages.data.flatMap((message) =>
      message.type === "assistant"
        ? message.content.flatMap((part) =>
          part.type === "tool" && part.name === "shell"
            ? [{ status: part.state?.status, error: part.state?.status === "error" ? part.state.error : undefined }]
            : [],
        )
        : [],
    )
    console.log(JSON.stringify({ quiescent: report.stable, unstable: report.unstable, toolStates }))
    yield* ui.screenshot("after-continuation")
    if (!report.stable || toolStates.length !== 1 || toolStates[0]?.status !== "error" || !toolStates[0].error)
      return yield* Effect.fail(new Error("expected one failed tool part and a stable continuation after transport death"))
  }))
}).pipe(Effect.scoped)
