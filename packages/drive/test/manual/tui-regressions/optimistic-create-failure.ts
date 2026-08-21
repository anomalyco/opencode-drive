import { defineScript } from "../../../src/index.js"
import { Effect } from "effect"
import { serveMarkers } from "./support.js"

// Failure-path probe for optimistic session creation (opencode PR #43687).
// When session.create fails after the optimistic navigation, the TUI must
// unwind: error toast, back to the home screen, draft restored into the
// composer. Nothing may be silently lost and no phantom session may linger.
//
//   bun run --cwd packages/drive drive start --name tui-optimistic-create-failure \
//     --script test/manual/tui-regressions/optimistic-create-failure.ts \
//     --dev "$OPENCODE_DEV"

const HOME_LOGO = "█▀▀█ █▀▀█ █▀▀█"

const frameText = (frame: { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }) =>
  frame.lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n")

export default defineScript({
  network: true,
  llm: { settlementTimeout: 120_000 },

  run: ({ ui, llm, network, opencode }) =>
    Effect.gen(function* () {
      const model = yield* serveMarkers(llm, { title: "Optimistic create failure probe" })
      model.track("FIRST")

      // Let startup catalog loads finish before degrading the network.
      yield* Effect.sleep(1500)

      // Kill the connection pool and refuse replacements: the create POST
      // must fail outright instead of hanging.
      yield* network.set({ refuseNew: true })
      yield* network.killConnections()
      yield* ui.submit("FIRST probe")

      // Expect the unwind: home screen back with the draft in the composer.
      const start = Date.now()
      let recoveredAfterMs: number | undefined
      while (Date.now() - start < 15_000) {
        if (yield* ui.matches(HOME_LOGO)) {
          recoveredAfterMs = Date.now() - start
          break
        }
        yield* Effect.sleep(50)
      }
      const frame = yield* ui.capture()
      const text = frameText(frame)
      const draftRestored = text.includes("FIRST probe")
      const toastShown = text.includes("Creating a session failed") || text.includes("Failed to")
      yield* ui.screenshot("after-failure")

      // Heal and confirm no phantom session reached the server and no ghost
      // tab survived the unwind (the tab strip must be empty again; a closed
      // tab resurrected by a late lock-serialized registration write shows up
      // as a lingering "New session" strip).
      yield* network.clear()
      yield* Effect.sleep(2000)
      const sessions = yield* opencode.session.list({ limit: 10, order: "desc" })
      const serverSessions = sessions.data.length
      const healed = yield* ui.capture()
      const strip = healed.lines[0]?.spans.map((span) => span.text).join("") ?? ""
      const ghostTab = strip.trim() !== ""

      const ok = recoveredAfterMs !== undefined && draftRestored && !ghostTab && serverSessions === 0
      console.log(
        JSON.stringify({
          recoveredAfterMs,
          draftRestored,
          toastShown,
          serverSessions,
          ghostTab,
          verdict: ok
            ? "ok: failed create unwound to home with the draft restored"
            : "FAIL: create failure did not unwind cleanly",
        }),
      )
      if (!ok) return yield* Effect.fail(new Error("create failure did not unwind cleanly"))
    }),
})
