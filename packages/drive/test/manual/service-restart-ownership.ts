import { defineScript, Llm } from "../../src/index.js"
import { Config, Effect, Option, Schedule, Schema, Stream } from "effect"

const Registration = Schema.Struct({ pid: Schema.Number, url: Schema.String })
const decodeRegistration = Schema.decodeUnknownEffect(Schema.fromJsonString(Registration))

export default defineScript({
  launch: "manual",
  run: ({ server, tuis, llm, artifacts }) =>
    Effect.gen(function* () {
      const cycles = yield* Config.int("OPENCODE_DRIVE_RESTART_CYCLES").pipe(Config.withDefault(1))
      const outage = yield* Config.int("OPENCODE_DRIVE_RESTART_GATE_MS").pipe(Config.withDefault(10_000))
      const registration = Effect.tryPromise(() =>
        Bun.file(`${artifacts}/home/.local/state/opencode/service-local.json`).text(),
      ).pipe(Effect.flatMap(decodeRegistration), Effect.option)
      const evidence: Array<unknown> = []
      const save = () =>
        Effect.promise(() => Bun.write(`${artifacts}/restart-ownership.json`, JSON.stringify(evidence, null, 2)))
      const original = yield* server.launch()
      const initial = yield* original.health.get()
      let response = "restart-ownership-ready"
      yield* llm.serve(() => Stream.make(Llm.text(response)))
      const tui = yield* tuis.launch("ownership")
      yield* tui.ui.submit("Establish the restart ownership fixture")
      yield* tui.ui.waitFor("restart-ownership-ready")

      yield* Effect.forEach(
        Array.from({ length: cycles }, (_, index) => index),
        (cycle) =>
          Effect.gen(function* () {
            const before = yield* original.health.get()
            const registered = yield* registration
            yield* server.kill()
            yield* tui.ui.waitFor("Connection lost", { timeout: 5_000 })
            // Hold the Drive replacement at a known boundary while reconnects run.
            const elected = yield* registration.pipe(
              Effect.filterOrFail((value) => Option.isSome(value) && value.value.pid !== before.pid),
              Effect.retry(Schedule.spaced(50)),
              Effect.timeoutOption(outage),
            )
            if (Option.isSome(elected)) {
              evidence.push({
                cycle,
                phase: "owned-server-down",
                before,
                registered,
                elected: elected.value,
              })
              yield* save()
              return yield* Effect.fail(new Error("TUI elected a replacement while the script server was stopped"))
            }
            const replacement = yield* server.launch()
            const current = yield* replacement.health.get()
            const oldClient = yield* original.health.get()
            const after = yield* registration
            evidence.push({
              cycle,
              before,
              registered,
              current,
              oldClient,
              after,
            })
            yield* save()
            if (current.pid === before.pid || oldClient.pid !== current.pid)
              return yield* Effect.fail(new Error("SDK did not reach the owned replacement server"))
            if (Option.isNone(registered) || Option.isNone(after) || registered.value.url !== after.value.url)
              return yield* Effect.fail(new Error("script server endpoint changed across restart"))
            yield* tui.ui.waitFor((state) => state.focused.editor, {
              timeout: 20_000,
            })
            response = `owned-replacement-${cycle}`
            yield* tui.ui.submit(`Verify owned replacement ${cycle}`)
            yield* tui.ui.waitFor(response)
          }),
      )
      console.log(
        JSON.stringify({
          verdict: "pass",
          cycles,
          outage,
          initialPID: initial.pid,
          evidence,
        }),
      )
    }),
})
