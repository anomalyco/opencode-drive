import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type {
  OpenCodeConfig,
  OpenCodeTuiConfig,
  Project,
  Setup,
} from "../project.js"
import type * as OpenCodeTui from "./client.js"
import type * as OpenCodeSdk from "./opencode.js"
import type { OpenCodeDriverError } from "./error.js"
import * as Lifecycle from "./lifecycle.js"
import type * as LlmController from "./llm-controller.js"
import type {
  LlmControllerError,
  LlmSettlementError,
} from "./llm-controller.js"
import type * as OpenCodeNetwork from "./network.js"
import type * as OpenCodeServer from "./server.js"
import type * as OpenCodeUi from "./ui.js"
import type { Llm } from "./llm.js"
import type { RunReport } from "./report.js"
import type * as Tool from "../tool/index.js"

export interface Options {
  readonly project?: Project
  readonly config?: OpenCodeConfig
  readonly tuiConfig?: OpenCodeTuiConfig
  readonly setup?: Setup
  readonly tools?: Tool.Configuration
  readonly tui?: OpenCodeTui.TuiOptions
  readonly opencode?: OpenCodeServer.Target
  /**
   * Routes every launched TUI, and clients using `server.endpoint()`, through
   * a controllable chaos network proxy.
   */
  readonly network?: boolean
  /** Simulated LLM timeouts, e.g. a longer settlementTimeout for hang scenarios. */
  readonly llm?: LlmController.Options
  readonly keepArtifacts?: boolean
}

export interface Driver {
  /** Generated SDK client connected to this driver's private OpenCode service. */
  readonly opencode: OpenCodeSdk.OpenCode
  readonly tui: OpenCodeTui.Tui
  /** Convenience alias for the primary TUI's UI. */
  readonly ui: OpenCodeUi.Ui
  readonly llm: Llm
  /** Chaos network controls. Operations require the network option. */
  readonly network: OpenCodeNetwork.Network
  /** Runtime controls for tools declared by name in the driver options. */
  readonly tools: Tool.Controls
  readonly tuis: OpenCodeTui.Tuis
  /** The shared OpenCode server, already launched by the driver. */
  readonly server: OpenCodeServer.Controls
  readonly artifacts: string
  /** The isolated project directory OpenCode runs in. */
  readonly directory: string
  /**
   * Variables that point another process, such as `opencode run` or an SDK
   * client using service discovery, at this driver's isolated OpenCode.
   * Spread them over `process.env` when spawning.
   */
  readonly environment: Readonly<Record<string, string>>
  /** Validates queued LLM work, stops TUIs, and exports recordings. */
  readonly settle: () => Effect.Effect<
    RunReport,
    | LlmControllerError
    | LlmSettlementError
    | OpenCodeDriverError
    | OpenCodeUi.OperationError
  >
}

const makeWithServices = Effect.fn("OpenCodeDriver.makeWithServices")(
  function* (options: Options = {}) {
    const prepared = yield* Lifecycle.prepare(options, "automatic")
    if (prepared.driver === undefined)
      return yield* Effect.die(
        new Error("automatic driver did not launch a TUI"),
      )
    return { driver: prepared.driver, failure: prepared.failure }
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

type Program<A, E, R> = Lifecycle.Program<Driver, A, E, R>

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
    return Effect.die(new Error("OpenCodeDriver.useReport requires a program"))
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
      ? Effect.die(new Error("OpenCodeDriver.use requires a program"))
      : run(optionsOrProgram, program)
}

export { OpenCodeDriverError } from "./error.js"
export { GuiLaunchError } from "./gui.js"
export {
  LlmControllerError,
  LlmModeError,
  LlmSettlementError,
} from "./llm-controller.js"
export {
  UiCapabilityError,
  UiElementAmbiguousError,
  UiNodeAmbiguousError,
  UiPredicateError,
  UiScreenshotError,
  UiTimeoutError,
  UiWaitOptionsError,
  UiWaitTimeoutError,
} from "./ui.js"
export { SimulationRequestError } from "../simulation/rpc.js"
export {
  SimulationCompatibilityError,
  SimulationConnectionError,
} from "../simulation/connector.js"
export type {
  CompatibilityPolicy,
  EndpointCompatibility,
} from "../simulation/connector.js"
export type {
  Recording,
  Tui,
  TuiLaunchError,
  TuiOptions,
  Tuis,
} from "./client.js"
export type { Llm } from "./llm.js"
export type { Network, NetworkConditions } from "./network.js"
export type { Target as OpenCodeTarget } from "./server.js"
export type { Endpoint, OpenCode } from "./opencode.js"
export type { ScreenshotError, Ui } from "./ui.js"
export type { Gui, GuiOptions } from "./gui.js"
export type {
  Project,
  ProjectFileSystem,
  Setup,
  SetupContext,
} from "../project.js"
export * from "./report.js"
