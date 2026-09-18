import { Effect, Fiber, Schedule } from "effect"
import { defineScript } from "../../../src/index.js"
import gauntlet from "./network-properties.js"
import { frameText, transcriptPaddingFindings } from "./padding-support.js"

// Runs the network gauntlet while sampling raw terminal frames and flagging
// message blocks whose padding rows went missing or whose rows lost the block
// background mid-paint. Offending frames are saved next to the run artifacts.
//
//   OPENCODE_DRIVE_SEED=42 OPENCODE_DRIVE_STEPS=24 \
//     bun run --cwd packages/drive drive start --name padding-gauntlet \
//     --script test/manual/tui-regressions/padding-gauntlet.ts --dev "$OPENCODE_DEV"

export default defineScript({
  ...gauntlet,
  config: { ...gauntlet.config, autoupdate: false },
  tuiConfig: { ...gauntlet.tuiConfig, session: { tps: true } },
  tui: { ...gauntlet.tui, viewport: { cols: 130, rows: 40 } },
  run: (caps) =>
    Effect.gen(function* () {
      const seen = new Set<string>()
      let samples = 0
      const sampler = yield* Effect.gen(function* () {
        const frame = yield* caps.ui.capture().pipe(Effect.timeout(2_000), Effect.option)
        if (frame._tag === "None") return
        samples += 1
        const issues = transcriptPaddingFindings(frame.value)
        if (issues.length === 0) return
        const key = issues.join("\n")
        if (seen.has(key)) return
        seen.add(key)
        const name = `padding-${String(seen.size).padStart(3, "0")}`
        const out = process.env.PADDING_GAUNTLET_OUT ?? caps.artifacts
        yield* Effect.promise(() =>
          Bun.write(`${out}/${name}.frame.json`, JSON.stringify({ issues, frame: frame.value }, null, 2)),
        )
        yield* Effect.promise(() => Bun.write(`${out}/${name}.txt`, frame.value.lines.map(frameText).join("\n")))
        console.error(`[padding] ${name}: ${issues.join(" | ")}`)
      }).pipe(Effect.repeat(Schedule.spaced(80)), Effect.forkScoped)
      yield* gauntlet.run(caps).pipe(Effect.ensuring(Fiber.interrupt(sampler)))
      console.log(JSON.stringify({ paddingSamples: samples, paddingFindings: seen.size }))
    }).pipe(Effect.scoped),
})
