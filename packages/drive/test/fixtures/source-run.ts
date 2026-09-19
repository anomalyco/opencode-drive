import { rm } from "node:fs/promises"
import * as Effect from "effect/Effect"
import { initializeInstance } from "../../src/instance/instance.js"

export default Effect.acquireUseRelease(
  Effect.promise(() => initializeInstance()),
  () => Effect.void,
  (artifacts) => Effect.promise(() => rm(artifacts, { recursive: true, force: true })),
)
