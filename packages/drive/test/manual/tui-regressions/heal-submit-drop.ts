import { defineScript, Llm } from "../../../src/index.js"
import { Effect, Stream } from "effect"

// Minimal repro distilled from network-properties seed 1 (steps 7-9):
// blackhole the network, heal it, then submit immediately. In the seeded runs
// the submit's enter was silently swallowed — text stayed in the composer and
// merged with the next prompt. This classifies when that happens:
//
//   for delay in 0 250 1000 3000; do OPENCODE_DRIVE_HEAL_DELAY=$delay ...
//
//   bun run --cwd packages/drive drive start --name tui-heal-submit-drop \
//     --script test/manual/tui-regressions/heal-submit-drop.ts \
//     --dev "$OPENCODE_DEV"

const healDelay = Number(process.env.OPENCODE_DRIVE_HEAL_DELAY ?? "0")
const stallMs = Number(process.env.OPENCODE_DRIVE_STALL_MS ?? "2500")

export default defineScript({
  network: true,
  llm: { settlementTimeout: 120_000 },

  run: ({ ui, llm, network, opencode, artifacts }) =>
    Effect.gen(function* () {
      yield* llm.serve((request) => {
        const body = JSON.stringify(request.body)
        if (body.includes("title generator"))
          return Stream.make(Llm.text("Heal submit drop probe"))
        if (body.lastIndexOf("SECOND") > body.lastIndexOf("FIRST"))
          return Stream.make(Llm.text("SECOND_DONE"))
        if (body.includes("FIRST")) return Stream.make(Llm.text("FIRST_DONE"))
        return Stream.make(Llm.text("UNMATCHED"))
      })

      // Healthy baseline.
      yield* ui.submit("FIRST probe")
      yield* ui.waitFor("FIRST_DONE", { timeout: 20_000 })

      // The seed-1 shape: a quiet blackhole window, then heal, then submit.
      yield* network.set({ blackhole: true })
      yield* Effect.sleep(stallMs)
      yield* network.clear()
      yield* Effect.sleep(healDelay)

      yield* ui.screenshot("pre-submit")
      yield* ui.submit("SECOND probe")
      yield* Effect.sleep(1_500)
      yield* ui.screenshot("post-submit")

      const replied = yield* ui
        .waitFor("SECOND_DONE", { timeout: 20_000 })
        .pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        )

      const sessions = yield* opencode.session.list({ limit: 1, order: "desc" })
      const sessionID = sessions.data[0]?.id
      if (sessionID === undefined) return yield* Effect.fail(new Error("no session"))
      const messages = yield* opencode.message.list({ sessionID, limit: 50, order: "desc" })
      const admitted = messages.data.filter(
        (message) => message.type === "user" && message.text.includes("SECOND"),
      ).length
      const history = yield* Effect.promise(() =>
        Bun.file(`${artifacts}/home/.local/state/opencode/prompt-history.jsonl`)
          .text()
          .catch(() => ""),
      )
      const inHistory = history.split("\n").some((line) => line.includes("SECOND"))

      console.log(
        JSON.stringify({
          healDelay,
          stallMs,
          admitted,
          replied,
          inHistory,
          verdict:
            admitted === 1 && replied
              ? "ok: admitted and replied"
              : admitted === 1
                ? "admitted but reply missing on screen"
                : inHistory
                  ? "submitted client-side but never admitted"
                  : "enter swallowed: no history entry, no admission",
        }),
      )
      if (admitted !== 1 || !replied) return yield* Effect.fail(new Error("drop reproduced"))
    }),
})
