import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import * as Effect from "effect/Effect"
import {
  prepareScriptTooling,
  typecheckPreparedTooling,
} from "../script/tooling.js"

export const runProgram = Effect.fn("Cli.runProgram")((file: string) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => prepareProgram(resolve(file)),
      catch: (cause) => cause,
    }),
    ({ file }) =>
      Effect.gen(function* () {
        const program = yield* Effect.tryPromise({
          // prepareProgram type-checks this boundary as a fully provided Effect.
          try: async (): Promise<Effect.Effect<unknown, unknown>> => {
            const module = await import(pathToFileURL(file).href)
            if (!Effect.isEffect(module.default))
              throw new Error("program must default-export a fully provided Effect")
            return module.default
          },
          catch: (cause) => cause,
        })
        return yield* program
      }),
    ({ remove }) => Effect.promise(remove),
  ),
)

async function prepareProgram(file: string) {
  const artifacts = await mkdtemp(join(tmpdir(), "opencode-drive-run-"))
  const contract = join(artifacts, "program-contract.ts")
  let links: Awaited<ReturnType<typeof prepareScriptTooling>>["links"] | undefined
  try {
    await Bun.write(
      contract,
      [
        'import type * as Effect from "effect/Effect"',
        `import program from ${JSON.stringify(file)}`,
        "const contract: Effect.Effect<unknown, unknown, never> = program",
        "void contract",
        "",
      ].join("\n"),
    )
    const tooling = await prepareScriptTooling(artifacts, contract, file)
    links = tooling.links
    await typecheckPreparedTooling(tooling, artifacts, "program")
    return {
      file,
      remove: async () => {
        await links?.remove()
        await rm(artifacts, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await links?.remove()
    await rm(artifacts, { recursive: true, force: true })
    throw error
  }
}
