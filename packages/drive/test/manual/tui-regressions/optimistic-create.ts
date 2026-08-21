import { defineScript } from "../../../src/index.js"
import { Effect } from "effect"
import { admissions, serveMarkers } from "./support.js"

// Probe for optimistic session creation (opencode issue #43563 / PR #43687).
// Enter on the home screen must feel sent immediately even on a slow
// connection: the TUI mints the session ID client-side, renders the prompt
// row, and navigates to the session view BEFORE the session.create round
// trip completes. A follow-up prompt submitted while the create is still in
// flight must gate on it instead of failing with "session not found".
//
// On pre-fix v2 the TUI awaits session.create (plus session.environment)
// before navigating, so with LATENCY_MS on the wire the home screen lingers
// for at least two round trips and the probe reports REPRO.
//
//   bun run --cwd packages/drive drive start --name tui-optimistic-create \
//     --script test/manual/tui-regressions/optimistic-create.ts \
//     --dev "$OPENCODE_DEV"

// A fragment of the ASCII wordmark that exists only on the home screen.
const HOME_LOGO = "█▀▀█ █▀▀█ █▀▀█"
const LATENCY_MS = 600

export default defineScript({
  network: true,
  llm: { settlementTimeout: 120_000 },

  run: ({ ui, llm, network, opencode }) =>
    Effect.gen(function* () {
      const model = yield* serveMarkers(llm, { title: "Optimistic create probe" })
      model.track("FIRST")
      model.track("SECOND")

      if (!(yield* ui.matches(HOME_LOGO))) return yield* Effect.fail(new Error("home logo marker not found"))

      // Let startup catalog loads (models, agents, integrations) finish
      // before degrading the network: a submit that races them trips the
      // model-readiness guard and never reaches session creation.
      yield* Effect.sleep(1500)

      // Every TUI<->server byte takes LATENCY_MS, so one HTTP round trip
      // costs at least 2x that. The Drive control plane stays clean, so the
      // polling below observes the real screen without added delay.
      yield* network.set({ latencyMs: LATENCY_MS })
      yield* ui.submit("FIRST probe")
      const submittedAt = Date.now()

      // Time how long the home screen survives the enter press.
      let navigatedAfterMs: number | undefined
      while (Date.now() - submittedAt < 10_000) {
        if (!(yield* ui.matches(HOME_LOGO))) {
          navigatedAfterMs = Date.now() - submittedAt
          break
        }
        yield* Effect.sleep(25)
      }
      const optimisticRow = navigatedAfterMs !== undefined && (yield* ui.matches("FIRST probe"))
      yield* ui.screenshot("after-enter")

      // Submit a follow-up while the create round trip is still in flight:
      // it must gate on the pending create, not 404 and roll back.
      const secondDuringCreate = navigatedAfterMs !== undefined && navigatedAfterMs < LATENCY_MS
      if (secondDuringCreate) {
        yield* Effect.sleep(150)
        yield* ui.submit("SECOND probe")
      }
      yield* network.clear()

      // Settle on server ground truth: with steer delivery the FIRST stream
      // may be superseded mid-run, so admissions are the invariant, plus a
      // final reply on screen.
      yield* ui.waitFor(secondDuringCreate ? "SECOND_DONE" : "FIRST_DONE", { timeout: 60_000 })
      yield* ui.screenshot("settled")
      const admittedFirst = yield* admissions(opencode, "FIRST probe")
      const admittedSecond = yield* admissions(opencode, "SECOND probe")

      const navigatedOptimistically = navigatedAfterMs !== undefined && navigatedAfterMs < LATENCY_MS
      console.log(
        JSON.stringify({
          navigatedAfterMs,
          optimisticRow,
          admittedFirst,
          admittedSecond,
          verdict: navigatedOptimistically
            ? "ok: enter navigated before the create round trip"
            : "REPRO: home screen blocked on session.create",
        }),
      )
      if (!navigatedOptimistically || !optimisticRow)
        return yield* Effect.fail(new Error("navigation waited for session.create"))
      if (admittedFirst !== 1 || admittedSecond !== 1)
        return yield* Effect.fail(new Error("prompt admissions were lost during optimistic create"))
    }),
})
