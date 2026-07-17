import * as Effect from "effect/Effect"
import * as Deferred from "effect/Deferred"
import * as Ref from "effect/Ref"
import * as Semaphore from "effect/Semaphore"
import * as Scope from "effect/Scope"
import * as Exit from "effect/Exit"
import * as OpenCodeInstance from "../instance/runtime.js"
import * as SimulationConnector from "../simulation/connector.js"
import * as OpenCodeClients from "./client.js"
import * as OpenCodeApi from "./api.js"
import { error, type OpenCodeDriverError } from "./error.js"
import * as LlmController from "./llm-controller.js"

export interface Target {
  readonly command?: ReadonlyArray<string>
  readonly dev?: string
  readonly env?: Readonly<Record<string, string>>
  readonly visible?: boolean
  readonly compatibility?: SimulationConnector.CompatibilityPolicy
}

export interface Options {
  readonly instance: OpenCodeInstance.Instance
  readonly target?: Target
}

export interface Server {
  readonly llm: LlmController.Controller
  readonly clients: OpenCodeClients.Control
  readonly launch: () => Effect.Effect<
    OpenCodeApi.Api,
    | OpenCodeDriverError
    | LlmController.LlmControllerError
    | SimulationConnector.SimulationCompatibilityError
  >
  readonly kill: () => Effect.Effect<void, OpenCodeDriverError>
  readonly failure: Effect.Effect<never, OpenCodeDriverError | LlmController.LlmControllerError>
  readonly compatibility: Effect.Effect<
    ReadonlyArray<SimulationConnector.EndpointCompatibility>
  >
}

export const make = Effect.fn("OpenCodeServer.make")(function* (
  options: Options,
) {
  const connector = yield* SimulationConnector.Service
  const target = options.target ?? {}
  const instance = options.instance
  const llm = yield* LlmController.make()
  const clients = yield* OpenCodeClients.makeClients(
    instance,
    target.visible ?? false,
    connector,
    target.compatibility,
  )
  const parentScope = yield* Scope.Scope
  const generation = yield* Ref.make<
    {
      readonly scope: Scope.Scope
      readonly attachment: LlmController.Attachment
      readonly process: import("../instance/process.js").Running
    } | undefined
  >(undefined)
  const unexpectedExit = yield* Deferred.make<never, OpenCodeDriverError>()
  const lifecycle = yield* Semaphore.make(1)
  let compatibility: ReadonlyArray<
    SimulationConnector.EndpointCompatibility
  > = []

  const launchGeneration = Effect.fn("OpenCodeServer.launch")(function* () {
    if ((yield* Ref.get(generation)) !== undefined)
      return yield* Effect.fail(
        error("server.launch", "the script server has already been launched"),
      )
    const scope = yield* Scope.fork(parentScope)
    const launched = yield* instance.launchServer.pipe(
      Effect.mapError((cause) => error("server.launch", cause)),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    )
    const backend = yield* connector.backend(launched.endpoint, {
      compatibility: target.compatibility,
    }).pipe(
      Scope.provide(scope),
      Effect.mapError((cause) => error("server.connect", cause)),
      Effect.onError(() =>
        instance.killServer.pipe(
          Effect.ignore,
          Effect.andThen(Scope.close(scope, Exit.void)),
        ),
      ),
    )
    const attachment = yield* llm.attach(backend).pipe(
      Effect.onError(() =>
        instance.killServer.pipe(
          Effect.ignore,
          Effect.andThen(Scope.close(scope, Exit.void)),
        ),
      ),
    )
    const api = yield* OpenCodeApi.make(instance.artifacts).pipe(
      Effect.onError(() =>
        instance.killServer.pipe(
          Effect.ignore,
          Effect.andThen(Scope.close(scope, Exit.void)),
        ),
      ),
    )
    const process = yield* instance.primary.pipe(
      Effect.mapError((cause) => error("server.launch", cause)),
    )
    yield* Ref.set(generation, { scope, attachment, process })
    compatibility = [...compatibility, backend.compatibility]
    yield* process.exitCode.pipe(
      Effect.tap(() => Effect.sleep(25)),
      Effect.flatMap((status) =>
        Ref.get(generation).pipe(
          Effect.flatMap((active) =>
            active?.process === process
              ? Deferred.fail(
                  unexpectedExit,
                  error("server.exit", `OpenCode server exited with status ${status}`),
                ).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ),
      Effect.catchCause(() => Effect.void),
      Effect.forkIn(scope),
    )
    return api
  })

  const killGeneration = Effect.fn("OpenCodeServer.kill")(function* () {
    const active = yield* Ref.get(generation)
    if (active === undefined)
      return yield* Effect.fail(
        error("server.kill", "the script server is not running"),
      )
    yield* Ref.set(generation, undefined)
    yield* active.attachment.detach()
    const stopped = yield* Effect.exit(
      instance.killServer.pipe(
        Effect.mapError((cause) => error("server.kill", cause)),
      ),
    )
    yield* Scope.close(active.scope, Exit.void)
    if (Exit.isFailure(stopped)) return yield* Effect.failCause(stopped.cause)
    return undefined
  })
  const launch = () => lifecycle.withPermit(launchGeneration())
  const kill = () => lifecycle.withPermit(killGeneration())

  return {
    llm,
    clients,
    launch,
    kill,
    failure: Effect.raceFirst(
      llm.failure,
      Deferred.await(unexpectedExit),
    ),
    compatibility: Effect.sync(() => compatibility),
  } satisfies Server
})

export * as OpenCodeServer from "./server.js"
