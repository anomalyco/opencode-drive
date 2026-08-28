import assert from "node:assert/strict"
import { Deferred, Effect, Stream } from "effect"
import { defineScript, Llm } from "../../../src/index.js"
import { latestSessionId, settled } from "./support.js"
import { saveFailure } from "./state-machine.js"

// Run each scenario independently so a failed checkpoint cannot mask later cases.
const scenario = process.env.OPENCODE_DRIVE_COMPACT_CASE ?? "ordered"
const cols = Number(process.env.OPENCODE_DRIVE_COLS ?? 100)

export default defineScript({
  network: true,
  project: { git: true, files: { "README.md": "# Admission fixture\n" } },
  config: { autoupdate: false, username: "Drive" },
  tui: { viewport: { cols, rows: 36 } },
  llm: { settlementTimeout: 60_000 },
  run: ({ ui, llm, network, opencode, artifacts }) =>
    Effect.scoped(
      Effect.gen(function* () {
        assert(
          ["ordered", "coalesce", "consumed", "cancelled", "rollback"].includes(scenario),
          "unknown compaction case",
        )
        const hold = yield* Deferred.make<void>()
        const trace: string[] = []
        const events: Array<Stream.Success<ReturnType<typeof opencode.event.subscribe>>> = []
        const checkpoint = (name: string) => {
          trace.push(name)
          console.error(JSON.stringify({ scenario, cols, checkpoint: name }))
        }
        const messages = (sessionID: Effect.Success<ReturnType<typeof latestSessionId>>) =>
          opencode.message.list({ sessionID, limit: 100, order: "asc" }).pipe(Effect.map((result) => result.data))
        const context = {
          ui,
          artifacts,
          evidence: () =>
            latestSessionId(opencode).pipe(
              Effect.flatMap((sessionID) =>
                Effect.all({
                  events: Effect.succeed(events),
                  messages: messages(sessionID),
                  inbox: opencode.session.inbox.list({ sessionID }),
                }),
              ),
            ),
        }
        yield* opencode.event.subscribe().pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event)
            }),
          ),
          Effect.forkScoped,
        )
        yield* llm.serve((request) => {
          const body = JSON.stringify(request.body)
          if (body.includes("title generator")) return Stream.make(Llm.text("Admission fixture"))
          if (body.includes("Create a new anchored summary") || body.includes("Update the anchored summary below"))
            return Stream.make(Llm.text("The fixture README was inspected."))
          // History includes previous markers. Only the newest prompt selects a reply.
          const marker = ["CA_WARM", "CA_HOLD", "CA_NEXT"].reduce((latest, candidate) =>
            body.lastIndexOf(candidate) > body.lastIndexOf(latest) ? candidate : latest,
          )
          // Pace the busy-step checkpoint independently of stream-publication behavior.
          if (marker === "CA_HOLD")
            return Stream.make(Llm.text("CA_HOLD_WORKING "), Llm.pause(150), Llm.text("waiting ")).pipe(
              Stream.concat(Stream.fromEffect(Deferred.await(hold).pipe(Effect.as(Llm.text("CA_HOLD_DONE"))))),
            )
          return Stream.make(Llm.text(`${marker}_DONE`))
        })

        yield* Effect.gen(function* () {
          yield* ui.submit("CA_WARM inspect the README")
          yield* ui.waitFor("CA_WARM_DONE", { timeout: 20_000 })
          const sessionID = yield* latestSessionId(opencode)
          yield* opencode.session.wait({ sessionID })
          assert((yield* settled(ui)).stable, "warmup did not settle")
          const compactions = messages(sessionID).pipe(
            Effect.map((rows) => rows.filter((row) => row.type === "compaction")),
          )
          const enqueued = () =>
            events
              .filter((event) => event.type === "session.inbox.enqueued")
              .filter((event) => event.data.sessionID === sessionID)
          const queuedRows = ui.capture().pipe(
            Effect.map(
              (frame) =>
                (
                  frame.lines
                    .map((line) => line.spans.map((span) => span.text).join(""))
                    .join("\n")
                    .match(/Compaction queued/g) ?? []
                ).length,
            ),
          )
          const converge = (statuses: ReadonlyArray<"completed" | "failed">) =>
            Effect.gen(function* () {
              yield* until(
                compactions,
                (rows) => rows.length === statuses.length && rows.every((row, index) => row.status === statuses[index]),
                "settled compactions",
              )
              yield* opencode.session.wait({ sessionID })
              yield* ui.waitFor(() => queuedRows.pipe(Effect.map((count) => count === 0)), { timeout: 20_000 })
              assert.equal((yield* opencode.session.inbox.list({ sessionID })).length, 0, "server inbox did not drain")
              assert((yield* settled(ui)).stable, "terminal did not settle")
              assert.deepEqual(
                (yield* compactions).map((row) => row.status),
                statuses,
                "extra compaction after settlement",
              )
              yield* ui.waitFor((state) => state.focused.editor)
              yield* ui.screenshot(`${scenario}-settled`)
            })

          if (scenario === "ordered" || scenario === "rollback") {
            checkpoint("blackhole-before-model-setup")
            yield* network.set({ blackhole: true })
            yield* ui.submit("/compact")
            yield* ui.waitFor("Compaction queued")
            yield* ui.submit("/compact")
            assert.equal(yield* queuedRows, 1, "repeat gesture duplicated the speculative row")
            assert.equal(
              (yield* opencode.session.inbox.list({ sessionID })).length,
              0,
              "admission crossed the partition",
            )
            assert.equal((yield* compactions).length, 0, "compaction executed before admission")
            yield* ui.screenshot(`${scenario}-pending`)

            if (scenario === "rollback") {
              checkpoint("kill-before-admission")
              yield* network.set({ blackhole: true, refuseNew: true })
              yield* network.killConnections()
              yield* ui.waitFor("Transport", { timeout: 15_000 })
              assert.equal(yield* queuedRows, 0, "unacknowledged row survived rejection")
              assert.equal((yield* compactions).length, 0, "failed request created a compaction")
              yield* ui.screenshot("rollback-error")
              yield* network.clear()
              yield* ui.waitFor((state) => state.focused.editor, {
                timeout: 30_000,
              })
              checkpoint("retry-after-heal")
              yield* ui.submit("/compact")
              yield* converge(["completed"])
              yield* ui.submit("CA_NEXT recovery prompt")
              yield* ui.waitFor("CA_NEXT_DONE", { timeout: 20_000 })
              yield* converge(["completed"])
            }

            if (scenario === "ordered") {
              checkpoint("following-prompt-before-heal")
              yield* ui.submit("CA_NEXT following prompt")
              yield* ui.waitFor("CA_NEXT following prompt")
              assert(
                !(yield* messages(sessionID)).some((row) => row.type === "user" && row.text.includes("CA_NEXT")),
                "following prompt crossed the partition",
              )
              yield* network.clear()
              yield* ui.waitFor("CA_NEXT_DONE", { timeout: 30_000 })
              yield* converge(["completed"])
              const admissions = enqueued()
              const compactIndex = admissions.findIndex((event) => event.data.item.type === "compaction")
              const promptIndex = admissions.findIndex(
                (event) => event.data.item.type === "user" && event.data.item.payload.text.includes("CA_NEXT"),
              )
              assert(compactIndex >= 0 && promptIndex > compactIndex, "following prompt overtook compaction admission")
            }
            const users = (yield* messages(sessionID)).filter(
              (row) => row.type === "user" && row.text.includes("CA_NEXT"),
            )
            assert.equal(users.length, 1, "following prompt was lost or admitted twice")
            assert.equal(
              enqueued().filter((event) => event.data.item.type === "compaction").length,
              1,
              "repeat gesture issued another admission",
            )
            checkpoint("verified")
            return
          }

          checkpoint("hold-active-step")
          yield* ui.submit("CA_HOLD keep this step open")
          yield* ui.waitFor("CA_HOLD_WORKING", { timeout: 20_000 })
          if (scenario === "coalesce") yield* network.set({ blackhole: true })
          const canonical = yield* opencode.session.compact({ sessionID })
          assert.deepEqual(
            (yield* opencode.session.inbox.list({ sessionID })).map((row) => row.id),
            [canonical.id],
          )
          if (scenario !== "coalesce") {
            yield* ui.waitFor("Compaction queued")
            yield* network.set({ blackhole: true })
          }
          checkpoint("submit-while-model-setup-blocked")
          yield* ui.submit("/compact")
          yield* ui.waitFor("Compaction queued")
          assert.equal(yield* queuedRows, 1, "known canonical and speculative rows were both shown")

          if (scenario === "coalesce") {
            checkpoint("heal-with-canonical-still-pending")
            yield* network.clear()
            // A following prompt is a send-chain barrier: when it reaches the
            // server, the TUI's compaction POST has settled and reconciled its ID.
            yield* ui.submit("CA_NEXT coalescing barrier")
            yield* until(
              opencode.session.inbox.list({ sessionID }),
              (rows) => rows.some((row) => row.type === "user" && row.payload.text.includes("CA_NEXT")),
              "following admission",
            )
            assert.equal(yield* queuedRows, 1, "canonical response left duplicate queued rows")
            assert.deepEqual(
              (yield* opencode.session.inbox.list({ sessionID }))
                .filter((row) => row.type === "compaction")
                .map((row) => row.id),
              [canonical.id],
            )
            yield* Deferred.succeed(hold, undefined)
            yield* ui.waitFor("CA_NEXT_DONE", { timeout: 30_000 })
            yield* converge(["completed"])
            assert.equal((yield* compactions)[0]?.id, canonical.id, "canonical ID was not retained")
          }

          if (scenario === "consumed" || scenario === "cancelled") {
            checkpoint(`${scenario}-before-heal`)
            if (scenario === "cancelled")
              yield* opencode.session.inbox.cancel({
                sessionID,
                inboxID: canonical.id,
              })
            yield* Deferred.succeed(hold, undefined)
            yield* opencode.session.wait({ sessionID })
            assert.equal((yield* compactions).length, scenario === "consumed" ? 1 : 0)
            assert.equal((yield* opencode.session.inbox.list({ sessionID })).length, 0)
            // The TUI still knows the old queued ID. The client proposes a
            // fresh ID when that item completes or is removed during setup.
            yield* network.clear()
            // With no new history, the second operation is durably admitted but
            // legitimately unavailable. It must not conflict or return to queued.
            yield* converge(scenario === "consumed" ? ["completed", "failed"] : ["completed"])
            if (scenario === "consumed") {
              const failed = (yield* compactions).find((row) => row.status === "failed")
              assert.equal(failed?.error.type, "compaction.unavailable")
              yield* ui.waitFor("Nothing to compact yet")
            }
            assert(
              (yield* compactions).some((row) => row.id !== canonical.id),
              "new compaction did not use a fresh control ID",
            )
            assert.equal(enqueued().filter((event) => event.data.item.type === "compaction").length, 2)
          }
          checkpoint("verified")
        }).pipe(
          Effect.catchCause((cause) =>
            saveFailure(context, { scenario, cols, trace }).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
          Effect.ensuring(Deferred.succeed(hold, undefined).pipe(Effect.andThen(network.clear()), Effect.orDie)),
        )
        console.log(JSON.stringify({ scenario, cols, trace, verdict: "pass" }))
      }),
    ),
})

function until<A, E>(read: Effect.Effect<A, E>, predicate: (value: A) => boolean, label: string) {
  return Effect.gen(function* () {
    while (true) {
      const value = yield* read
      if (predicate(value)) return value
      yield* Effect.sleep(50)
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: 20_000,
      orElse: () => Effect.fail(new Error(`timed out waiting for ${label}`)),
    }),
  )
}
