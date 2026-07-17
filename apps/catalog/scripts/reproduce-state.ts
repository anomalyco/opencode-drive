import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { OpenCodeDriver } from "opencode-drive"
import { executeFlow } from "../catalog/flow"
import { executableFlows } from "../scenarios"

const defaultOpenCode = fileURLToPath(new URL("../../../../opencode-v2-latest/", import.meta.url))
const options = parseArgs(process.argv.slice(2))
const selected = executableFlows.flatMap((flow) =>
  flow.states.flatMap((state) => state.address === options.address ? [{ flow, state }] : []),
)[0]

if (!selected) {
  const known = executableFlows.flatMap((flow) => flow.states.map((state) => state.address))
  throw new Error(`Unknown catalog state ${JSON.stringify(options.address)}. Known states:\n${known.join("\n")}`)
}

await Effect.runPromise(
  OpenCodeDriver.use(
    {
      project: { files: { "fixture.txt": "before\n" } },
      config: {
        autoupdate: false,
        permissions: [{ action: "*", resource: "*", effect: "ask" }],
      },
      setup:
        options.theme === undefined
          ? undefined
          : ({ fs }) =>
              fs.writeFile(
                ".opencode/tui.json",
                `${JSON.stringify({ $schema: "https://opencode.ai/tui.json", theme: options.theme }, undefined, 2)}\n`,
              ),
      client: { viewport: { cols: 118, rows: 34 } },
      opencode: { dev: options.opencode },
    },
    (driver) => executeFlow(selected.flow, {
      driver,
      through: selected.state,
      capture: () => Effect.gen(function* () {
        const frame = yield* driver.ui.capture()
        yield* Effect.promise(() => mkdir(dirname(options.output), { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(
            options.output,
            `${JSON.stringify({ format: "opencode-terminal-frame-v1", ...frame })}\n`,
          ),
        )
      }),
    }),
  ),
)

console.log(options.output)

function parseArgs(args: ReadonlyArray<string>) {
  const address = args[0]
  if (!address || address.startsWith("--")) {
    throw new Error("Usage: reproduce-state <flow-id/state-id> [--opencode path] [--output path] [--theme name]")
  }
  let opencode = defaultOpenCode
  let output = resolve(`.tmp/reproductions/${address.replace("/", "--")}.frame.json`)
  let theme: string | undefined
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]
    const value = args[++index]
    if (!value) throw new Error(`${flag} requires a value`)
    if (flag === "--opencode") opencode = resolve(value)
    else if (flag === "--output") output = resolve(value)
    else if (flag === "--theme") theme = value
    else throw new Error(`Unknown argument ${flag}`)
  }
  return { address, opencode, output, theme }
}
