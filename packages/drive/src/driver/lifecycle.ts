import * as Effect from "effect/Effect"
import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as OpenCodeInstance from "../instance/runtime.js"
import * as SimulationConnector from "../simulation/connector.js"
import { error, type OpenCodeDriverError } from "./error.js"
import type { Driver, Options } from "./index.js"
import type { LlmControllerError } from "./llm-controller.js"
import * as OpenCodeProject from "./project.js"
import * as PreparedDriver from "./prepared.js"
import * as ToolController from "../tool/controller.js"

// Shared by OpenCodeDriver and OpenCodeBackend: both prepare the same isolated
// instance and settle it the same way, and differ only in whether a primary
// TUI is launched.

export const layer = Layer.merge(SimulationConnector.layer, NodeServices.layer)

export const prepare = Effect.fn("OpenCodeDriver.prepare")(function* (
  options: Options,
  launch: "automatic" | "manual",
) {
  const toolController = yield* ToolController.make(options.tools)
  const project = yield* OpenCodeProject.make({
    project: options.project,
    config: options.config,
    tui: options.tuiConfig,
    setup: ToolController.composeSetup(toolController, options.setup),
    keepArtifacts: options.keepArtifacts,
  })
  const instance = yield* OpenCodeInstance.make({
    artifacts: project.artifacts,
    directory: project.directory,
    name: `library-${crypto.randomUUID().slice(0, 12)}`,
    scripted: true,
    command: options.opencode?.command,
    dev: options.opencode?.dev,
    env: options.opencode?.env,
    network: options.network,
    visible: options.opencode?.visible,
  }, toolController).pipe(Effect.mapError((cause) => error("server.prepare", cause)))
  return yield* PreparedDriver.makeWithServices(instance, {
    visible: options.opencode?.visible,
    launch,
    tui: options.tui,
    artifactsRetained: options.keepArtifacts ?? false,
    compatibility: options.opencode?.compatibility,
    ...(options.llm === undefined ? {} : { llm: options.llm }),
  })
})

export interface Managed<D> {
  readonly driver: D
  readonly failure: Effect.Effect<never, LlmControllerError | OpenCodeDriverError>
}

export type Program<D, A, E, R> = (driver: D) => Effect.Effect<A, E, R>

export const runReport = <D extends Pick<Driver, "settle">, ME, A, E, R>(
  managed: Effect.Effect<Managed<D>, ME, Scope.Scope>,
  f: Program<D, A, E, R>,
) =>
  Effect.scoped(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const { driver, failure } = yield* managed
        const useExit = yield* Effect.exit(
          restore(Effect.raceFirst(f(driver), failure)),
        )
        const settlement = yield* Effect.exit(driver.settle())
        if (Exit.isFailure(useExit) && Exit.isFailure(settlement))
          return yield* Effect.failCause(
            Cause.combine(useExit.cause, settlement.cause),
          )
        if (Exit.isFailure(useExit)) return yield* Effect.failCause(useExit.cause)
        if (Exit.isFailure(settlement))
          return yield* Effect.failCause(settlement.cause)
        return { value: useExit.value, report: settlement.value }
      }),
    ),
  )
