import { defineScript, Llm } from "../../../src/index.js"
import { Effect, Stream } from "effect"

// Probes whether a plain-enter steer submitted mid-stream is ever silently
// dropped (text left in the composer, no admission, no feedback). Runs on a
// CLEAN network: any drop here is a pure TUI lifecycle bug, not chaos.
//
//   bun run --cwd packages/drive drive start --name tui-steer-enter-drop \
//     --script test/manual/tui-regressions/steer-enter-drop.ts \
//     --dev "$OPENCODE_DEV"

const offsets = [0, 300, 700, 1_200, 1_800]

export default defineScript({
  llm: { settlementTimeout: 180_000 },

  run: ({ ui, llm, opencode, artifacts }) =>
    Effect.gen(function* () {
      const markers: Array<string> = []
      yield* llm.serve((request) => {
        const body = JSON.stringify(request.body)
        if (body.includes("title generator"))
          return Stream.make(Llm.text("Steer drop probe"))
        let marker: string | undefined
        let position = -1
        for (const candidate of markers) {
          const index = body.lastIndexOf(candidate)
          if (index > position) {
            position = index
            marker = candidate
          }
        }
        if (marker === undefined) return Stream.make(Llm.text("UNMATCHED"))
        return Stream.make(
          Llm.text(`${marker}_WORKING `),
          Llm.pause(800),
          Llm.text("streaming along "),
          Llm.pause(800),
          Llm.text("nearly there "),
          Llm.pause(800),
          Llm.text(`${marker}_DONE`),
        )
      })

      const results: Array<{
        offset: number
        steerInHistory: boolean
        admitted: number
        repliedOnScreen: boolean
      }> = []

      for (let index = 0; index < offsets.length; index++) {
        const offset = offsets[index]!
        const first = `A${index}Z`
        const steer = `B${index}Z`
        markers.push(first, steer)

        yield* ui.submit(`${first} start the stream`)
        yield* ui.waitFor(`${first}_WORKING`, { timeout: 20_000 })
        yield* Effect.sleep(offset)
        yield* ui.submit(`${steer} steer now`)

        // Let both settle generously, then judge by evidence instead of failing.
        yield* ui.waitFor(`${first}_DONE`, { timeout: 30_000 })
        const repliedOnScreen = yield* ui
          .waitFor(`${steer}_DONE`, { timeout: 20_000 })
          .pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          )

        const sessions = yield* opencode.session.list({ limit: 1, order: "desc" })
        const sessionID = sessions.data[0]?.id
        if (sessionID === undefined) return yield* Effect.fail(new Error("no session"))
        const messages = yield* opencode.message.list({ sessionID, limit: 100, order: "desc" })
        const admitted = messages.data.filter(
          (message) => message.type === "user" && message.text.includes(steer),
        ).length
        const history = yield* Effect.promise(() =>
          Bun.file(
            `${artifacts}/home/.local/state/opencode/prompt-history.jsonl`,
          )
            .text()
            .catch(() => ""),
        )
        const steerInHistory = history
          .split("\n")
          .some((line) => line.includes(steer) && !line.includes(first))
        results.push({ offset, steerInHistory, admitted, repliedOnScreen })
        if (!repliedOnScreen) yield* ui.screenshot(`steer-drop-${offset}ms`)

        // Clear any leftover composer text so iterations stay independent.
        // (ctrl+c would exit the TUI; ctrl+u kills the line.)
        yield* ui.press("u", { ctrl: true })
      }

      console.log(JSON.stringify({ results }, undefined, 2))
      const dropped = results.filter((entry) => entry.admitted === 0)
      if (dropped.length > 0)
        return yield* Effect.fail(
          new Error(
            `steer enter dropped at offsets: ${dropped.map((entry) => entry.offset).join(", ")}ms`,
          ),
        )
    }),
})
