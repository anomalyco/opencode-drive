import * as Effect from "effect/Effect"
import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import { NodeServices } from "@effect/platform-node"
import * as OpenCodeInstance from "../instance/runtime.js"
import * as SimulationConnector from "../simulation/connector.js"
import type {
  OpenCodeConfig,
  OpenCodeTuiConfig,
  ScriptProject,
  ScriptSetup,
} from "../script/types.js"
import * as OpenCodeClient from "./client.js"
import type * as OpenCodeApi from "./api.js"
import { error, type OpenCodeDriverError } from "./error.js"
import type {
  LlmControllerError,
  LlmSettlementError,
} from "./llm-controller.js"
import * as OpenCodeProject from "./project.js"
import * as PreparedDriver from "./prepared.js"
import * as OpenCodeServer from "./server.js"
import type * as OpenCodeUi from "./ui.js"
import type { RunReport } from "./report.js"
import * as ToolController from "../tool/controller.js"
import type * as Tool from "../tool/index.js"

export interface Options {
  readonly project?: ScriptProject
  readonly config?: OpenCodeConfig
  readonly tui?: OpenCodeTuiConfig
  readonly setup?: ScriptSetup
  readonly tools?: Tool.Setup
  readonly client?: OpenCodeClient.Options
  readonly opencode?: OpenCodeServer.Target
  readonly keepArtifacts?: boolean
}

export interface Driver {
  /** Typed client connected to this driver's private OpenCode service. */
  readonly api: OpenCodeApi.Api
  readonly ui: OpenCodeUi.Ui
  readonly llm: Llm
  readonly clients: OpenCodeClient.Clients
  readonly artifacts: string
  readonly recording?: OpenCodeClient.Recording
  /** Validates queued LLM work, stops clients, and finishes recording timelines without exporting them. */
  readonly finish: () => Effect.Effect<
    void,
    | LlmControllerError
    | LlmSettlementError
    | OpenCodeDriverError
    | OpenCodeUi.OperationError
  >
  /** Validates queued LLM work, stops clients, and exports recordings. */
  readonly settle: () => Effect.Effect<
    Settlement,
    | LlmControllerError
    | LlmSettlementError
    | OpenCodeDriverError
    | OpenCodeUi.OperationError
  >
}

export interface Llm {
  readonly queue: OpenCodeServer.Server["llm"]["queue"]
  readonly send: OpenCodeServer.Server["llm"]["send"]
  readonly serve: OpenCodeServer.Server["llm"]["serve"]
  readonly title: OpenCodeServer.Server["llm"]["title"]
  readonly settle: OpenCodeServer.Server["llm"]["settle"]
}

export interface Settlement {
  readonly recordings: ReadonlyArray<string>
  readonly report: RunReport
}

export interface RunResult<A> {
  readonly value: A
  readonly report: RunReport
}

const makeWithServices = Effect.fn("OpenCodeDriver.makeWithServices")(
  function* (options: Options = {}) {
    const toolController = yield* ToolController.make(options.tools)
    const project = yield* OpenCodeProject.make({
      project: options.project,
      config: options.config,
      tui: options.tui,
      setup: ToolController.composeSetup(toolController, options.tools, options.setup),
      keepArtifacts: options.keepArtifacts,
    })
    const instance = yield* OpenCodeInstance.make({
      artifacts: project.artifacts,
      name: `library-${crypto.randomUUID().slice(0, 12)}`,
      scripted: true,
      command: options.opencode?.command,
      dev: options.opencode?.dev,
      env: options.opencode?.env,
      visible: options.opencode?.visible,
    }).pipe(Effect.mapError((cause) => error("server.prepare", cause)))
    const prepared = yield* PreparedDriver.makeWithServices(instance, {
      visible: options.opencode?.visible,
      client: options.client,
      artifactsRetained: options.keepArtifacts ?? false,
      compatibility: options.opencode?.compatibility,
    })
    if (prepared.driver === undefined)
      return yield* Effect.die(
        new Error("automatic driver did not launch a client"),
      )
    return { driver: prepared.driver, failure: prepared.failure }
  },
)

type MakeWithServices = ReturnType<typeof makeWithServices>

const makeManaged = (
  options: Options = {},
): Effect.Effect<
  Effect.Success<MakeWithServices>,
  Effect.Error<MakeWithServices>
> => {
  const managed = makeWithServices(options).pipe(
    Effect.provide([SimulationConnector.layer, NodeServices.layer]),
  )
  // NodeServices.layer currently exposes an `any` input requirement even though
  // it and SimulationConnector.layer fully provide this module's dependencies.
  return managed as Effect.Effect<
    Effect.Success<MakeWithServices>,
    Effect.Error<MakeWithServices>
  >
}

export const make = (options: Options = {}) =>
  makeManaged(options).pipe(Effect.map(({ driver }) => driver))

export const useReport = <A, E, R>(
  options: Options,
  f: (driver: Driver) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const { driver, failure } = yield* makeManaged(options)
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
        return { value: useExit.value, report: settlement.value.report }
      }),
    ),
  )

export const use = <A, E, R>(
  options: Options,
  f: (driver: Driver) => Effect.Effect<A, E, R>,
) => useReport(options, f).pipe(Effect.map(({ value }) => value))

export { OpenCodeDriverError } from "./error.js"
export {
  LlmControllerError,
  LlmModeError,
  LlmSettlementError,
} from "./llm-controller.js"
export {
  UiElementAmbiguousError,
  UiTimeoutError,
  UiWaitOptionsError,
} from "./ui.js"
export { SimulationRequestError } from "../simulation/rpc.js"
export { SimulationConnectionError } from "../simulation/connector.js"
export type { Client, Clients, Recording } from "./client.js"
export type { Api } from "./api.js"
export type { Ui } from "./ui.js"
export * from "./report.js"
