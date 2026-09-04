import { Effect, Fiber, Scope } from "effect"

/** Starts a terminal operation once in its owner's scope, independently of callers. */
export const make = Effect.fn("SharedEffect.make")(function* <A, E>(
  effect: Effect.Effect<A, E>,
) {
  const scope = yield* Scope.Scope
  const start = yield* Effect.cached(
    Effect.forkIn(Effect.exit(effect), scope, { uninterruptible: true }),
  )
  return start.pipe(
    Effect.uninterruptible,
    Effect.flatMap(Fiber.join),
    Effect.flatten,
  )
})
