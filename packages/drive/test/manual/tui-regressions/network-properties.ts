import { defineScript, Llm } from "../../../src/index.js"
import type { OpenCode, Ui } from "../../../src/index.js"
import type { Network } from "../../../src/driver/network.js"
import { Effect, Random, Stream } from "effect"
import { run } from "./state-machine.js"

// Seeded network-chaos property run. User operations and network faults are
// transitions in one seeded state machine: prompts stream paced replies while
// latency windows, blackhole partitions, and connection kills land between
// and across them. Verification follows the liveness-mode recipe: heal the
// network, then require every outstanding prompt to converge on screen and in
// the server projection, and the composer to stay actionable.
//
//   OPENCODE_DRIVE_SEED=42 OPENCODE_DRIVE_STEPS=24 \
//     bun run --cwd packages/drive drive start --name tui-network-properties \
//     --script test/manual/tui-regressions/network-properties.ts \
//     --dev "$OPENCODE_DEV"

const seed = readInteger("OPENCODE_DRIVE_SEED", 1, Number.MAX_SAFE_INTEGER)
const steps = readInteger("OPENCODE_DRIVE_STEPS", 18, 1_000)

interface Model {
  readonly submitted: number
  readonly outstanding: ReadonlyArray<string>
  readonly conditions: "clear" | "latency" | "blackhole"
  /**
   * Wall-clock guards keeping connection kills away from in-flight prompt
   * POSTs: a killed POST legitimately rolls the optimistic prompt back, which
   * would false-fail the every-submit-converges invariant. Deterministic
   * scenarios cover that rollback path instead.
   */
  readonly lastSubmitAt: number
  readonly lastHealAt: number
  readonly coverage: {
    readonly kills: number
    readonly latencyWindows: number
    readonly blackholes: number
    readonly steers: number
    readonly verifications: number
  }
}

type SessionID = Effect.Success<
  ReturnType<OpenCode["session"]["list"]>
>["data"][number]["id"]

export default defineScript({
  network: true,
  llm: { settlementTimeout: 120_000 },

  run: ({ ui, llm, network, opencode, artifacts }) =>
    Effect.gen(function* () {
      const markers: Array<string> = []
      yield* llm.serve((request) => {
        const body = JSON.stringify(request.body)
        if (body.includes("title generator"))
          return Stream.make(Llm.text("Network properties"))
        let marker: string | undefined
        let position = -1
        for (const candidate of markers) {
          const index = body.lastIndexOf(candidate)
          if (index > position) {
            position = index
            marker = candidate
          }
        }
        if (marker === undefined)
          return Stream.make(Llm.text("GAUNTLET_UNMATCHED_PROMPT"))
        // Pace the reply over ~2.5s so faults can land mid-stream. The
        // terminal token only renders once the whole reply arrived.
        return Stream.make(
          Llm.text(`${marker}_WORKING`),
          Llm.pause(800),
          Llm.text(" streaming through the gauntlet "),
          Llm.pause(800),
          Llm.text("still streaming "),
          Llm.pause(800),
          Llm.text(`${marker}_DONE`),
        )
      })

      const latestSession = opencode.session
        .list({ limit: 1, order: "desc" })
        .pipe(
          Effect.flatMap((sessions) =>
            sessions.data[0] === undefined
              ? Effect.fail(new Error("no session was created"))
              : Effect.succeed(sessions.data[0].id),
          ),
        )

      const verifyConverged = Effect.fn("NetworkProperties.verify")(function* (
        outstanding: ReadonlyArray<string>,
      ) {
        // Heal every fault first: convergence is only required of a healthy
        // network, and buffered partition bytes flush on clear.
        yield* network.clear()
        if (outstanding.length === 0) return
        for (const marker of outstanding) {
          yield* ui.waitFor(`${marker}_DONE`, { timeout: 60_000 })
        }
        const sessionID: SessionID = yield* latestSession
        const messages = yield* opencode.message.list({
          sessionID,
          limit: 100,
          order: "desc",
        })
        for (const marker of outstanding) {
          const users = messages.data.filter(
            (message) => message.type === "user" && message.text.includes(marker),
          )
          if (users.length !== 1)
            return yield* Effect.fail(
              new Error(
                `prompt ${marker} appears ${users.length} times in the server projection`,
              ),
            )
          const replied = messages.data.some(
            (message) =>
              message.type === "assistant" &&
              message.content.some(
                (part) => part.type === "text" && part.text.includes(`${marker}_DONE`),
              ),
          )
          if (!replied)
            return yield* Effect.fail(
              new Error(`reply for ${marker} is missing from the server projection`),
            )
        }
        // The composer must come back actionable after convergence.
        yield* ui.waitFor((state) => state.focused.editor, { timeout: 15_000 })
      })

      const submitMarker = (model: Model) =>
        Effect.gen(function* () {
          const marker = `M${model.submitted}X`
          markers.push(marker)
          yield* ui.submit(`${marker} run the gauntlet drill`)
          return marker
        })

      const initial: Model = {
        submitted: 0,
        outstanding: [],
        conditions: "clear",
        lastSubmitAt: 0,
        lastHealAt: 0,
        coverage: { kills: 0, latencyWindows: 0, blackholes: 0, steers: 0, verifications: 0 },
      }

      const evidence = () =>
        latestSession.pipe(
          Effect.flatMap((sessionID) =>
            opencode.message.list({ sessionID, limit: 20, order: "desc" }),
          ),
        )

      const final = yield* run<Model>({
        context: { ui, artifacts, evidence },
        initial,
        seed,
        steps,
        transitions: [
          {
            name: "submit",
            enabled: (state) =>
              state.outstanding.length < 2 && state.conditions !== "blackhole",
            run: (state) =>
              Effect.gen(function* () {
                const marker = yield* submitMarker(state)
                return {
                  ...state,
                  submitted: state.submitted + 1,
                  outstanding: [...state.outstanding, marker],
                  lastSubmitAt: Date.now(),
                  coverage: {
                    ...state.coverage,
                    steers: state.coverage.steers + (state.outstanding.length > 0 ? 1 : 0),
                  },
                }
              }),
          },
          {
            name: "latency-window",
            enabled: (state) => state.submitted > 0 && state.conditions === "clear",
            run: (state) =>
              Effect.gen(function* () {
                const ms = yield* Random.nextIntBetween(100, 700)
                const jitter = yield* Random.nextIntBetween(0, 300)
                yield* network.set({ latencyMs: ms, jitterMs: jitter })
                return {
                  ...state,
                  conditions: "latency" as const,
                  coverage: {
                    ...state.coverage,
                    latencyWindows: state.coverage.latencyWindows + 1,
                  },
                }
              }),
          },
          {
            name: "blackhole-window",
            enabled: (state) => state.submitted > 0 && state.conditions !== "blackhole",
            run: (state) =>
              network.set({ blackhole: true }).pipe(
                Effect.as({
                  ...state,
                  conditions: "blackhole" as const,
                  coverage: {
                    ...state.coverage,
                    blackholes: state.coverage.blackholes + 1,
                  },
                }),
              ),
          },
          {
            name: "heal",
            enabled: (state) => state.conditions !== "clear",
            run: (state) =>
              network.clear().pipe(
                Effect.as({
                  ...state,
                  conditions: "clear" as const,
                  lastHealAt: Date.now(),
                }),
              ),
          },
          {
            name: "kill-connections",
            enabled: (state) =>
              state.submitted > 0 &&
              state.conditions === "clear" &&
              Date.now() - state.lastSubmitAt > 3_000 &&
              Date.now() - state.lastHealAt > 2_000,
            run: (state) =>
              network.killConnections().pipe(
                Effect.as({
                  ...state,
                  coverage: { ...state.coverage, kills: state.coverage.kills + 1 },
                }),
              ),
          },
          {
            name: "pause",
            enabled: (state) => state.submitted > 0,
            run: (state) =>
              Random.nextIntBetween(300, 1_200).pipe(
                Effect.flatMap((ms) => Effect.sleep(ms)),
                Effect.as(state),
              ),
          },
          {
            name: "verify",
            enabled: (state) => state.outstanding.length > 0,
            run: (state) =>
              verifyConverged(state.outstanding).pipe(
                Effect.as({
                  ...state,
                  outstanding: [],
                  conditions: "clear" as const,
                  lastHealAt: Date.now(),
                  coverage: {
                    ...state.coverage,
                    verifications: state.coverage.verifications + 1,
                  },
                }),
              ),
          },
        ],
        invariants: [
          {
            name: "control plane responds",
            check: () => ui.state().pipe(Effect.timeout(10_000), Effect.asVoid),
          },
          {
            name: "no unmatched prompt reached the model",
            check: () =>
              ui.matches("GAUNTLET_UNMATCHED_PROMPT").pipe(
                Effect.flatMap((matched) =>
                  matched
                    ? Effect.fail(new Error("an unmatched prompt reached the simulated model"))
                    : Effect.void,
                ),
              ),
          },
        ],
      })

      // Terminal convergence: whatever the seed left outstanding must land,
      // and one final prompt proves the composer survived the whole run.
      yield* verifyConverged(final.outstanding)
      const closing = `M${final.submitted}X`
      markers.push(closing)
      yield* ui.submit(`${closing} closing probe`)
      yield* verifyConverged([closing])

      console.log(
        JSON.stringify({
          seed,
          steps,
          coverage: final.coverage,
          submitted: final.submitted + 1,
        }),
      )
    }),
})

function readInteger(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name])
  if (!Number.isInteger(value) || value < 1 || value > maximum) return fallback
  return value
}
