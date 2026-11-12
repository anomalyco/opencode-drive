import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { Driver, Options as DriverOptions } from "./index.js"
import * as Lifecycle from "./lifecycle.js"

// The driver without a primary TUI: Drive owns the isolated service, simulated
// LLM, tools, and settlement, and the program launches its own client, such as
// OpenCode Desktop, a web frontend, or a native app, against `server.endpoint()`.

export interface Options extends Omit<DriverOptions, "tui"> {}

export interface Backend extends Omit<Driver, "tui" | "ui"> {}

const makeWithServices = Effect.fn("OpenCodeBackend.makeWithServices")(
  function* (options: Options = {}) {
    const prepared = yield* Lifecycle.prepare(options, "manual")
    const opencode = yield* prepared.server.launch()
    const backend: Backend = {
      opencode,
      llm: prepared.llm,
      network: prepared.network,
      tools: prepared.tools,
      tuis: prepared.tuis,
      server: prepared.server,
      artifacts: prepared.artifacts,
      directory: prepared.directory,
      environment: prepared.environment,
      settle: prepared.settle,
    }
    return { driver: backend, failure: prepared.failure }
  },
)

type MakeWithServices = ReturnType<typeof makeWithServices>

const makeManaged = (
  options: Options = {},
): Effect.Effect<
  Effect.Success<MakeWithServices>,
  Effect.Error<MakeWithServices>,
  Scope.Scope
> =>
  makeWithServices(options).pipe(
    Effect.provide(Lifecycle.layer),
  )

export const make = (options: Options = {}) =>
  makeManaged(options).pipe(Effect.map(({ driver }) => driver))

type Program<A, E, R> = Lifecycle.Program<Backend, A, E, R>

const runReport = <A, E, R>(
  options: Options,
  f: Program<A, E, R>,
) => Lifecycle.runReport(makeManaged(options), f)

export function useReport<A, E, R>(
  f: Program<A, E, R>,
): ReturnType<typeof runReport<A, E, R>>
export function useReport<A, E, R>(
  options: Options,
  f: Program<A, E, R>,
): ReturnType<typeof runReport<A, E, R>>
export function useReport<A, E, R>(
  optionsOrProgram: Options | Program<A, E, R>,
  program?: Program<A, E, R>,
) {
  if (typeof optionsOrProgram === "function")
    return runReport({}, optionsOrProgram)
  if (program === undefined)
    return Effect.die(new Error("OpenCodeBackend.useReport requires a program"))
  return runReport(optionsOrProgram, program)
}

const run = <A, E, R>(options: Options, program: Program<A, E, R>) =>
  runReport(options, program).pipe(Effect.map(({ value }) => value))

export function use<A, E, R>(
  f: Program<A, E, R>,
): ReturnType<typeof run<A, E, R>>
export function use<A, E, R>(
  options: Options,
  f: Program<A, E, R>,
): ReturnType<typeof run<A, E, R>>
export function use<A, E, R>(
  optionsOrProgram: Options | Program<A, E, R>,
  program?: Program<A, E, R>,
) {
  return typeof optionsOrProgram === "function"
    ? run({}, optionsOrProgram)
    : program === undefined
      ? Effect.die(new Error("OpenCodeBackend.use requires a program"))
      : run(optionsOrProgram, program)
}

export * as OpenCodeBackend from "./backend.js"
