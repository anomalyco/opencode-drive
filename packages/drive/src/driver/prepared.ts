import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as OpenCodeInstance from "../instance/runtime.js"
import * as SimulationConnector from "../simulation/connector.js"
import * as OpenCodeClient from "./client.js"
import { error, type OpenCodeDriverError } from "./error.js"
import type {
  Driver,
  Llm,
} from "./index.js"
import type {
  LlmControllerError,
  LlmSettlementError,
} from "./llm-controller.js"
import * as OpenCodeServer from "./server.js"
import * as SharedEffect from "./shared.js"
import type * as OpenCodeUi from "./ui.js"
import { decodeRunReport } from "./report.js"

export interface Options {
  readonly visible?: boolean
  readonly client?: OpenCodeClient.Options
  readonly launch?: "automatic" | "manual"
  readonly clientName?: string
  readonly artifactsRetained?: boolean
  readonly compatibility?: SimulationConnector.CompatibilityPolicy
}

export interface Prepared {
  readonly driver: Driver | undefined
  readonly primary: OpenCodeClient.Client | undefined
  readonly llm: Llm
  readonly clients: OpenCodeClient.Clients
  readonly server: Pick<OpenCodeServer.Server, "launch" | "kill">
  readonly artifacts: string
  readonly settle: Driver["settle"]
  readonly failure: Effect.Effect<never, LlmControllerError | OpenCodeDriverError>
  readonly unexpectedClientExit: OpenCodeClient.Control["unexpectedExit"]
}

export const makeWithServices = Effect.fn("OpenCodeDriver.makePreparedWithServices")(
  function* (
    instance: OpenCodeInstance.Instance,
    options: Options = {},
  ) {
    const server = yield* OpenCodeServer.make({
      instance,
      target: {
        visible: options.visible,
        compatibility: options.compatibility,
      },
    })
    const api = (options.launch ?? "automatic") === "automatic"
      ? yield* server.launch()
      : undefined
    const primary = (options.launch ?? "automatic") === "automatic"
      ? options.clientName === undefined
        ? yield* server.clients.make(options.client)
        : yield* server.clients.launch(options.clientName, options.client)
      : undefined
    const complete = (
      clients: Effect.Effect<
        ReadonlyArray<string>,
        OpenCodeDriverError | OpenCodeUi.OperationError
      >,
    ) =>
      Effect.gen(function* () {
        const llm = yield* Effect.exit(server.llm.settle())
        const shutdown = yield* Effect.exit(server.llm.shutdown())
        const clientExit = yield* Effect.exit(clients)
        let failure: Cause.Cause<
          | LlmControllerError
          | LlmSettlementError
          | OpenCodeDriverError
          | OpenCodeUi.OperationError
        > | undefined
        if (Exit.isFailure(llm)) failure = llm.cause
        if (Exit.isFailure(shutdown))
          failure = failure === undefined
            ? shutdown.cause
            : Cause.combine(failure, shutdown.cause)
        if (Exit.isFailure(clientExit))
          failure = failure === undefined
            ? clientExit.cause
            : Cause.combine(failure, clientExit.cause)
        if (failure !== undefined) return yield* Effect.failCause(failure)
        const compatibility = [
          ...(yield* server.compatibility),
          ...(yield* server.clients.compatibility),
        ]
        const recordings = Exit.isSuccess(clientExit) ? clientExit.value : []
        const report = yield* decodeRunReport({
          artifacts: instance.artifacts,
          retained: options.artifactsRetained ?? true,
          recordings,
          compatibility,
        }).pipe(
          Effect.mapError((cause) => error("report.make", cause)),
        )
        return report
      })
    const settle = yield* SharedEffect.make(complete(server.clients.settle()))
    yield* Effect.addFinalizer(() => server.llm.shutdown())
    const llm: Llm = server.llm
    const driver: Driver | undefined = primary === undefined || api === undefined
      ? undefined
      : {
          api,
          client: primary,
          ui: primary.ui,
          llm,
          clients: server.clients,
          artifacts: instance.artifacts,
          settle: () => settle,
        }
    return {
      driver,
      primary,
      llm,
      clients: server.clients,
      server,
      artifacts: instance.artifacts,
      settle: () => settle,
      failure: Effect.raceFirst(
        server.failure,
        server.clients.unexpectedExit.pipe(
          Effect.flatMap(({ name, status }) =>
            Effect.fail(
              error(
                "client.exit",
                `OpenCode client "${name}" exited with status ${status}`,
              ),
            ),
          ),
        ),
      ),
      unexpectedClientExit: server.clients.unexpectedExit,
    } satisfies Prepared
  },
)

export const make = (
  instance: OpenCodeInstance.Instance,
  options: Options = {},
) =>
  makeWithServices(instance, options).pipe(
    Effect.provide(SimulationConnector.layer),
  )
