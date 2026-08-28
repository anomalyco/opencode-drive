import assert from "node:assert/strict"
import { Effect } from "effect"
import { defineScript, Llm } from "opencode-drive"

// Check first, then `drive start --script ... --dev <isolated V2 checkout>`
// with OPENCODE_DRIVE_DB=release-relaunch.sqlite to retain the first session.
export default defineScript({
  launch: "manual",
  config: { autoupdate: false },
  tui: { viewport: { cols: 100, rows: 35 } },
  run: ({ server, tuis, llm }) =>
    Effect.gen(function* () {
      yield* llm.title(() => Effect.succeed("Drive relaunch"))
      const first = yield* server.launch()
      const tui = yield* tuis.launch("release-relaunch")
      yield* llm.queue(Llm.text("BEFORE_RELAUNCH_OK", { delay: 0 }))
      yield* tui.ui.submit("First generation fixture")
      yield* tui.ui.waitFor("BEFORE_RELAUNCH_OK")
      const sessionID = (yield* first.session.list({ limit: 1, order: "desc" })).data[0]?.id
      assert(sessionID)
      yield* first.session.wait({ sessionID })
      yield* tui.close()
      yield* server.kill()

      const second = yield* server.launch()
      assert.equal((yield* second.session.get({ sessionID })).id, sessionID)
      const relaunched = yield* tuis.launch("release-relaunch")
      yield* llm.queue(Llm.text("AFTER_RELAUNCH_OK", { delay: 0 }))
      yield* relaunched.ui.submit("Second generation fixture")
      yield* relaunched.ui.waitFor("AFTER_RELAUNCH_OK")
      const secondID = (yield* second.session.list({ limit: 1, order: "desc" })).data[0]?.id
      assert(secondID)
      yield* second.session.wait({ sessionID: secondID })
      assert.deepEqual(yield* second.session.inbox.list({ sessionID: secondID }), [])
      assert.equal((yield* relaunched.ui.capture()).cols, 100)
      console.log(yield* relaunched.ui.screenshot("release-relaunch"))
      yield* relaunched.close()
      yield* server.kill()
      console.log("CHECKED_SCRIPT_RELAUNCH_OK")
    }).pipe(Effect.timeout("90 seconds")),
})
