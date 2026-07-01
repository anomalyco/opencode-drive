import { Effect } from "effect"
import { generateProbeData } from "./generate.js"

const program = generateProbeData.pipe(
  Effect.tap((data) => Effect.sync(() => console.log(JSON.stringify(data, undefined, 2)))),
)

await Effect.runPromise(program)
