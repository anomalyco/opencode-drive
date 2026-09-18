import { Effect, Fiber, Random, Schedule, Stream } from "effect"
import { defineScript, Llm } from "../../../src/index.js"
import { frameText, transcriptPaddingFindings } from "./padding-support.js"

// Tool-heavy padding probe: every prompt runs a controlled shell call with
// streamed progress before a paced text reply, under latency windows and
// connection kills. Frames are sampled throughout; any transcript block that
// lost its padding row is saved to PADDING_GAUNTLET_OUT.
//
//   OPENCODE_DRIVE_SEED=42 OPENCODE_DRIVE_STEPS=12 \
//     bun run --cwd packages/drive drive start --name padding-tools \
//     --script test/manual/tui-regressions/padding-tools.ts --dev "$OPENCODE_DEV"

const seed = Number(process.env.OPENCODE_DRIVE_SEED ?? 1)
const steps = Number(process.env.OPENCODE_DRIVE_STEPS ?? 12)
const command =
  "xcodebuild test -project OpenCode.xcodeproj -scheme OpenCode -destination 'platform=iOS Simulator,id=8551E9D9-7768-4AFF-BC5D-7EFFF9FC5662' -derivedDataPath /tmp/dd"

export default defineScript({
  network: true,
  tools: ["shell"],
  llm: { settlementTimeout: 120_000 },
  config: { autoupdate: false, username: "Drive" },
  tuiConfig: { session: { tps: true } },
  tui: { viewport: { cols: 130, rows: 40 } },
  run: ({ ui, llm, network, tools, artifacts }) =>
    Effect.gen(function* () {
      const out = process.env.PADDING_GAUNTLET_OUT ?? artifacts
      const seen = new Set<string>()
      let samples = 0
      const sampler = yield* Effect.gen(function* () {
        const frame = yield* ui.capture().pipe(Effect.timeout(2_000), Effect.option)
        if (frame._tag === "None") return
        samples += 1
        const issues = transcriptPaddingFindings(frame.value)
        if (issues.length === 0) return
        const key = issues.join("\n")
        if (seen.has(key)) return
        seen.add(key)
        const name = `tools-${seed}-${String(seen.size).padStart(3, "0")}`
        yield* Effect.promise(() =>
          Bun.write(`${out}/${name}.frame.json`, JSON.stringify({ issues, frame: frame.value }, null, 2)),
        )
        yield* Effect.promise(() => Bun.write(`${out}/${name}.txt`, frame.value.lines.map(frameText).join("\n")))
        console.error(`[padding] ${name}: ${issues.join(" | ")}`)
      }).pipe(Effect.repeat(Schedule.spaced(80)), Effect.forkScoped)

      const shells = yield* tools.control("shell")
      yield* llm.serve((request, index) => {
        const body = JSON.stringify(request)
        const marker = `T${index}X`
        // The body carries the whole conversation: reply with text only when the
        // newest prompt already has its shell result behind it.
        const toolResultIsNewest = body.lastIndexOf("Finished") > body.lastIndexOf("run the simulator tests")
        return toolResultIsNewest
          ? Stream.make(
              Llm.text(`${marker}_WORKING `),
              Llm.pause(600),
              Llm.text("summarising the simulator run "),
              Llm.pause(600),
              Llm.text(`${marker}_DONE`),
            )
          : Stream.make(
              Llm.toolCall({ index: 0, id: `call_shell_${index}`, name: "shell", input: { command } }),
              Llm.finish("tool-calls"),
            )
      })

      const run = Effect.fn("PaddingTools.step")(function* (step: number) {
        const marker = `P${step}X`
        const latency = yield* Random.nextIntBetween(0, 500)
        if (latency > 150) yield* network.set({ latencyMs: latency, jitterMs: 150 })
        yield* ui.submit(`${marker} run the simulator tests`)
        const shell = yield* shells.take()
        const lines = yield* Random.nextIntBetween(3, 12)
        for (let i = 0; i < lines; i++) {
          yield* shell.progress(
            Array.from({ length: i + 1 }, (_, n) => `[2026-09-16 17:52:${String(n).padStart(2, "0")} +0000] Status=4294967295, isTerminal=YES`).join("\n") + "\n",
          )
          yield* Effect.sleep(120)
        }
        if ((yield* Random.nextBoolean) && step > 0) yield* network.killConnections()
        yield* shell.succeed({ output: "Finished\n", exit: 0 })
        yield* network.clear()
        yield* ui.waitFor("_DONE", { timeout: 60_000 })
        yield* Effect.sleep(yield* Random.nextIntBetween(200, 900))
      })

      yield* Effect.forEach(Array.from({ length: steps }, (_, step) => step), run).pipe(
        Random.withSeed(seed),
        Effect.ensuring(Fiber.interrupt(sampler)),
      )
      console.log(JSON.stringify({ seed, steps, paddingSamples: samples, paddingFindings: seen.size }))
    }).pipe(Effect.scoped),
})
