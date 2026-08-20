import type { Ui } from "../../../src/index.js"
import { Effect, Exit, Random } from "effect"

export interface Context {
  readonly ui: Ui
  readonly artifacts: string
  readonly evidence?: () => Effect.Effect<unknown, unknown>
}

export interface Transition<State> {
  readonly name: string
  readonly enabled: (state: State) => boolean
  readonly run: (state: State, step: number) => Effect.Effect<State, unknown>
}

export interface Invariant<State> {
  readonly name: string
  readonly check: (state: State) => Effect.Effect<void, unknown>
}

/**
 * Writes a failure artifact with the seed, trace, model state, server
 * evidence, and a best-effort terminal frame. Used by the runner for
 * transition/invariant failures and by probes for terminal-phase failures so
 * every failed seed keeps its reproduction context.
 */
export const saveFailure = (
  context: Context,
  details: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const path = `${context.artifacts}/state-machine-failure.json`
    const [frame, evidence] = yield* Effect.all([
      context.ui.capture().pipe(Effect.option),
      context.evidence?.().pipe(Effect.option) ?? Effect.succeed(undefined),
    ])
    yield* Effect.tryPromise(() =>
      Bun.write(
        path,
        JSON.stringify(
          {
            ...details,
            evidence:
              evidence !== undefined && evidence._tag === "Some" ? evidence.value : undefined,
            frame: frame._tag === "Some" ? frame.value : undefined,
          },
          null,
          2,
        ),
      ),
    )
    return path
  }).pipe(Effect.option)

export function run<State>(options: {
  readonly context: Context
  readonly initial: State
  readonly seed: number
  readonly steps: number
  readonly transitions: ReadonlyArray<Transition<State>>
  readonly invariants: ReadonlyArray<Invariant<State>>
}) {
  return Effect.gen(function* () {
    const trace: Array<{ step: number; transition: string }> = []
    let state = options.initial

    for (let step = 0; step < options.steps; step++) {
      const enabled = options.transitions.filter((transition) => transition.enabled(state))
      if (enabled.length === 0)
        return yield* Effect.fail(new Error(`state machine has no transition at step ${step}`))
      const transition = yield* Random.choice(enabled)
      trace.push({ step, transition: transition.name })
      console.error(JSON.stringify({ seed: options.seed, step, transition: transition.name }))
      let invariant: string | undefined
      let next = state
      const result = yield* Effect.exit(
        Effect.gen(function* () {
          next = yield* transition.run(state, step)
          for (const current of options.invariants) {
            invariant = current.name
            yield* current.check(next)
          }
        }),
      )
      if (Exit.isSuccess(result)) {
        state = next
        continue
      }

      const path = yield* saveFailure(options.context, {
        seed: options.seed,
        steps: options.steps,
        failedAt: step,
        transition: transition.name,
        invariant,
        trace,
        state: next,
      })
      console.error(
        JSON.stringify({
          seed: options.seed,
          step,
          transition: transition.name,
          invariant,
          artifact: path._tag === "Some" ? path.value : undefined,
        }),
      )
      return yield* Effect.failCause(result.cause)
    }

    console.log(JSON.stringify({ seed: options.seed, steps: options.steps, trace }))
    return state
  }).pipe(Random.withSeed(options.seed))
}
