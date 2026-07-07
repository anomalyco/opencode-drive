import { Effect, Schema } from "effect"
import { configProfiles, generateConfigJson, type ConfigJson } from "./config.js"

// Imported through a variable so `tsgo` does not typecheck all of OpenCode
// core; the runtime import still tracks the latest checkout.
const opencodeConfigModule = "../../opencode-latest/packages/core/src/config.ts"

export interface GenerateConfigsOptions {
  readonly count?: number
  readonly seed?: number
}

/**
 * Generates realistic OpenCode config.json objects and validates every one of
 * them against the latest checkout's `Config.Info` schema, so the generator
 * fails loudly whenever upstream config contracts change.
 */
export const generateConfigs = (
  options?: GenerateConfigsOptions,
): Effect.Effect<ReadonlyArray<ConfigJson>> =>
  Effect.promise(async () => {
    const { Config } = await import(opencodeConfigModule)
    const decode = Schema.decodeUnknownSync(Config.Info)
    const count = options?.count ?? 8
    const seed = options?.seed ?? 1
    return Array.from({ length: count }, (_, index) => {
      const profile = configProfiles[index % configProfiles.length]!
      const config = generateConfigJson({ seed: seed + index, profile })
      decode(config)
      return config
    })
  })
