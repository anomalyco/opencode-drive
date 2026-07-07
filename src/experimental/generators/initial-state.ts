import { configProfiles, generateConfigJson, type ConfigJson, type ConfigProfile } from "./config.js"
import { generateFilesForConfig, type VirtualFileTree } from "./filesystem.js"
import { createRng } from "./random.js"

/**
 * One complete initial state for model-based testing:
 * the config OpenCode reads, the files it can see, and the environment.
 *
 * The config generator stays pure (config objects only); this module is the
 * coordination point that keeps config and filesystem coherent.
 */
export interface InitialState {
  readonly config: ConfigJson
  readonly files: VirtualFileTree
  readonly env: Readonly<Record<string, string>>
}

export interface InitialStateOptions {
  readonly seed?: number
  readonly profile?: ConfigProfile
}

export const generateInitialState = (options?: InitialStateOptions): InitialState => {
  const seed = options?.seed ?? 1
  const rng = createRng(seed * 7919 + 17)
  const config = generateConfigJson({ seed, ...(options?.profile === undefined ? {} : { profile: options.profile }) })
  const files = generateFilesForConfig(config, seed * 31 + 7)
  const env: Record<string, string> = rng.boolean(0.2) ? { OPENCODE_DISABLE_AUTOUPDATE: "1" } : {}
  return { config, files, env }
}

export const generateInitialStates = (count: number, options?: { readonly seed?: number }): InitialState[] => {
  const seed = options?.seed ?? 1
  return Array.from({ length: count }, (_, index) =>
    generateInitialState({ seed: seed + index, profile: configProfiles[index % configProfiles.length]! }),
  )
}
