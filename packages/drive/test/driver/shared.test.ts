import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Latch, Ref, Scope } from "effect"
import * as SharedEffect from "../../src/driver/shared.js"

it.effect("does not let an interrupted caller poison terminal work", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const runs = yield* Ref.make(0)
    const shared = yield* SharedEffect.make(
      Ref.update(runs, (count) => count + 1).pipe(
        Effect.andThen(Deferred.await(gate)),
        Effect.as("settled"),
      ),
    )
    const first = yield* Effect.forkChild(shared)
    yield* Effect.yieldNow
    yield* Fiber.interrupt(first)
    yield* Deferred.succeed(gate, undefined)

    expect(yield* shared).toBe("settled")
    expect(yield* Ref.get(runs)).toBe(1)
  }),
)

it.effect("shares one lazy result after every original waiter leaves", () => Effect.gen(function* () {
  const entered = yield* Latch.make()
  const gate = yield* Latch.make()
  const runs = yield* Ref.make(0)
  const shared = yield* SharedEffect.make(Effect.gen(function* () {
    yield* Ref.update(runs, (count) => count + 1)
    yield* entered.open
    yield* gate.await
    return "done"
  }))
  expect(yield* Ref.get(runs)).toBe(0)
  const first = yield* Effect.forkChild(shared)
  const second = yield* Effect.forkChild(shared)
  yield* entered.await
  yield* Fiber.interrupt(first)
  yield* Fiber.interrupt(second)
  yield* gate.open
  expect(yield* shared).toBe("done")
  expect(yield* shared).toBe("done")
  expect(yield* Ref.get(runs)).toBe(1)
}))

it.effect("replays failures and defects without rerunning", () => Effect.gen(function* () {
  for (const failure of [Effect.fail("failed"), Effect.die("defect")]) {
    const runs = yield* Ref.make(0)
    const shared = yield* SharedEffect.make(Ref.update(runs, (count) => count + 1).pipe(Effect.andThen(failure)))
    const first = yield* Effect.exit(shared)
    const second = yield* Effect.exit(shared)
    expect(first).toEqual(second)
    expect(Exit.isFailure(first)).toBe(true)
    expect(yield* Ref.get(runs)).toBe(1)
  }
}))

it.effect("owner shutdown joins terminal work, including a first start from its finalizer", () => Effect.gen(function* () {
  const scope = yield* Scope.make()
  const entered = yield* Latch.make()
  const gate = yield* Latch.make()
  const shared = yield* SharedEffect.make(entered.open.pipe(Effect.andThen(gate.await))).pipe(Scope.provide(scope))
  yield* Scope.addFinalizer(scope, shared)
  const close = yield* Effect.forkChild(Scope.close(scope, Exit.void))
  yield* entered.await
  expect(close.pollUnsafe()).toBeUndefined()
  yield* gate.open
  yield* Fiber.join(close)
}))
