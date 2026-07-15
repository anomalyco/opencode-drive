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
import { error, type OpenCodeDriverError } from "./error.js"
import type {
  LlmControllerError,
  LlmSettlementError,
} from "./llm-controller.js"
import * as OpenCodeProject from "./project.js"
import * as PreparedDriver from "./prepared.js"
import * as OpenCodeServer from "./server.js"
import type * as OpenCodeUi from "./ui.js"

export interface Options {
  readonly project?: ScriptProject
  readonly config?: OpenCodeConfig
  readonly tui?: OpenCodeTuiConfig
  readonly setup?: ScriptSetup
  readonly client?: OpenCodeClient.Options
  readonly opencode?: OpenCodeServer.Target
  readonly keepArtifacts?: boolean
}

export interface Driver {
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
}

const makeWithServices = Effect.fn("OpenCodeDriver.makeWithServices")(
  function* (options: Options = {}) {
    const project = yield* OpenCodeProject.make({
      project: options.project,
      config: options.config,
      tui: options.tui,
      setup: options.setup,
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
    })
    if (prepared.driver === undefined)
      return yield* Effect.die(
        new Error("automatic driver did not launch a client"),
      )
    return { driver: prepared.driver, failure: prepared.failure }
  },
)

const makeManaged = (options: Options = {}) =>
  makeWithServices(options).pipe(
    Effect.provide(SimulationConnector.layer),
    Effect.provide(NodeServices.layer),
  )

export const make = (options: Options = {}) =>
  makeManaged(options).pipe(Effect.map(({ driver }) => driver))

export const use = <A, E, R>(
  options: Options,
  f: (driver: Driver) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.acquireUseRelease(
      makeManaged(options),
      ({ driver, failure }) => Effect.raceFirst(f(driver), failure),
      ({ driver }, useExit) =>
        Effect.gen(function* () {
          const settlement = yield* Effect.exit(driver.settle())
          if (Exit.isSuccess(settlement)) return undefined
          if (Exit.isFailure(useExit))
            return yield* Effect.failCause(
              Cause.combine(useExit.cause, settlement.cause),
            )
          return yield* Effect.failCause(settlement.cause)
        }),
    ),
  )

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
export type { Ui } from "./ui.js"
export * from "./report.js"
