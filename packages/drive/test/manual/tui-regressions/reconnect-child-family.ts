import assert from "node:assert/strict"
import { Deferred, Effect, Schedule, Stream } from "effect"
import { defineScript, Llm, type JsonValue } from "../../../src/index.js"

// Deterministic reduction of stale-running.ts seed 5. A background subagent
// starts while the TUI is offline, so the TUI misses its `session.created`
// event. After reconnecting, the open picker must still mark the root session
// as running because its child is running.
//
//   OPENCODE_DRIVE_MEDIA_DIR="$PWD/.drive-output" \
//     bun run --cwd packages/drive drive start --daemon --name reconnect-child-family \
//     --script test/manual/tui-regressions/reconnect-child-family.ts \
//     --dev "$OPENCODE_DEV"
//
// OPENCODE_DRIVE_LABEL prefixes the recording annotation, for example BEFORE or AFTER.

const SPINNER = new Set(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏", "⋯"])
const label = process.env.OPENCODE_DRIVE_LABEL

export default defineScript({
  network: true,
  llm: { settlementTimeout: 60_000 },
  project: { git: true, files: { "README.md": "# Reconnect fixture\n" } },
  config: { autoupdate: false, username: "Drive" },
  tui: { viewport: { cols: 100, rows: 24 }, recording: true },
  run: ({ ui, tui, llm, network, opencode, artifacts }) =>
    Effect.gen(function* () {
      const recording = tui.recording
      if (!recording) return yield* Effect.fail(new Error("recording is not enabled"))
      const gate = yield* Deferred.make<void>()
      yield* llm.serve((request) => {
        const body = JSON.stringify(request.body)
        if (body.includes("title generator")) return Stream.make(Llm.text("Release checklist"))
        // The parent's follow-up also carries CHILD_TASK inside the tool-call arguments.
        if (body.includes("call_audit")) return Stream.make(Llm.text("The audit is running in the background."))
        if (body.includes("CHILD_TASK"))
          return Stream.fromEffect(Deferred.await(gate)).pipe(
            Stream.flatMap(() => Stream.make(Llm.text("Audit complete."))),
          )
        return Stream.make(
          Llm.toolCall({
            index: 0,
            id: "call_audit",
            name: offeredTools(request.body).includes("subagent") ? "subagent" : "task",
            input: {
              agent: "general",
              description: "Audit quality loops",
              prompt: "CHILD_TASK audit the release checklist",
              background: true,
            },
          }),
          Llm.finish("tool-calls"),
        )
      })

      const location = yield* opencode.location.get({ location: { directory: `${artifacts}/files` } })
      const catalog = yield* Effect.repeat(
        Effect.all({
          model: opencode.model.default({ location }).pipe(Effect.map((output) => output.data)),
          agent: opencode.agent
            .list({ location })
            .pipe(Effect.map((output) => output.data.find((agent) => agent.id === "build"))),
        }),
        { until: (value) => value.model !== undefined && value.agent !== undefined, schedule: Schedule.spaced(50) },
      )
      const root = yield* opencode.session.create({
        title: "Release checklist",
        location,
        model: { providerID: catalog.model!.providerID, id: catalog.model!.id },
        agent: catalog.agent!.id,
      })
      yield* Effect.sleep(1_500)

      yield* recording.mark("TUI offline: a background subagent starts")
      yield* network.set({ refuseNew: true })
      yield* network.killConnections()
      yield* Effect.sleep(1_000)
      yield* opencode.session.prompt({ sessionID: root.id, text: "Audit the release checklist in the background." })
      const child = yield* Effect.repeat(opencode.session.list({ parentID: root.id, limit: 10 }), {
        until: (sessions) => sessions.data.length > 0,
        schedule: Schedule.spaced(100),
      }).pipe(
        Effect.timeoutOrElse({
          duration: 20_000,
          orElse: () =>
            opencode.message
              .list({ sessionID: root.id, limit: 20 })
              .pipe(Effect.flatMap((messages) => Effect.fail(new Error(`no child: ${JSON.stringify(messages.data)}`)))),
        }),
        Effect.map((sessions) => sessions.data[0]!),
      )
      // The parent finishes its step; only the background child keeps running.
      yield* Effect.repeat(opencode.session.active(), {
        until: (active) => child.id in active && !(root.id in active),
        schedule: Schedule.spaced(100),
      }).pipe(
        Effect.timeoutOrElse({
          duration: 20_000,
          orElse: () =>
            opencode.session
              .active()
              .pipe(Effect.flatMap((active) => Effect.fail(new Error(`unexpected activity: ${JSON.stringify(active)}`)))),
        }),
      )

      yield* recording.mark("TUI reconnects")
      yield* network.clear()
      yield* Effect.sleep(3_000)

      yield* ui.press("o", { ctrl: true })
      yield* ui.waitFor("Search sessions and", { timeout: 5_000 })
      yield* ui.type("Release")
      yield* ui.waitFor("Release checklist", { timeout: 10_000 })
      yield* Effect.sleep(500)
      const input = yield* ui.getElement({ focused: true })
      const row = (yield* ui.capture()).lines
        .slice(input.y + 1)
        .map((line) => line.spans.map((span) => span.text).join(""))
        .find((text) => text.includes("Release checklist"))
      assert(row !== undefined, "picker row is missing")
      const running = [...row.slice(0, row.indexOf("Release checklist"))].some((char) => SPINNER.has(char))
      yield* recording.mark(
        `${label ? `${label}: ` : ""}child running → root row ${running ? "shows spinner" : "shows idle"}`,
      )
      yield* Effect.sleep(4_000)
      yield* ui.screenshot(`reconnect-child-family-${label ?? "run"}`)
      yield* ui.press("escape")
      yield* recording.mark("")

      yield* Deferred.succeed(gate, undefined)
      // Export before asserting so a failing (pre-fix) run still produces its recording.
      const video = yield* recording.finish()
      console.log(JSON.stringify({ child: child.id, rootRowRunning: running, video }))
      assert(running, "root row must show the running background child after reconnect")
    }),
})

function offeredTools(body: JsonValue) {
  if (!isJsonObject(body)) return []
  const tools = body.tools
  if (!Array.isArray(tools)) return []
  return tools.flatMap((tool) => {
    if (!isJsonObject(tool)) return []
    const definition = tool.function
    if (!isJsonObject(definition) || typeof definition.name !== "string") return []
    return [definition.name]
  })
}

function isJsonObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
