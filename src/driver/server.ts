import * as Effect from "effect/Effect"
import * as Deferred from "effect/Deferred"
import * as Ref from "effect/Ref"
import * as Scope from "effect/Scope"
import * as Exit from "effect/Exit"
import * as OpenCodeInstance from "../instance/runtime.js"
import * as SimulationConnector from "../simulation/connector.js"
import * as OpenCodeClients from "./client.js"
import { error, type OpenCodeDriverError } from "./error.js"
import * as LlmController from "./llm-controller.js"

export interface Target {
  readonly command?: ReadonlyArray<string>
  readonly dev?: string
  readonly env?: Readonly<Record<string, string>>
  readonly visible?: boolean
}

export interface Options {
  readonly instance: OpenCodeInstance.Instance
  readonly target?: Target
}

export interface Server {
  readonly llm: LlmController.Controller
  readonly clients: OpenCodeClients.Control
  readonly launch: () => Effect.Effect<void, OpenCodeDriverError | LlmController.LlmControllerError>
  readonly kill: () => Effect.Effect<void, OpenCodeDriverError>
  readonly failure: Effect.Effect<never, OpenCodeDriverError | LlmController.LlmControllerError>
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

  const launch = Effect.fn("OpenCodeServer.launch")(function* () {
    if ((yield* Ref.get(generation)) !== undefined)
      return yield* Effect.fail(
        error("server.launch", "the script server has already been launched"),
      )
    const scope = yield* Scope.fork(parentScope)
    const launched = yield* instance.launchServer.pipe(
      Effect.mapError((cause) => error("server.launch", cause)),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    )
    const backend = yield* connector.backend(launched.endpoint).pipe(
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
    const process = yield* instance.primary.pipe(
      Effect.mapError((cause) => error("server.launch", cause)),
    )
    yield* Ref.set(generation, { scope, attachment, process })
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
    return undefined
  })

  const kill = Effect.fn("OpenCodeServer.kill")(function* () {
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

  return {
    llm,
    clients,
    launch,
    kill,
    failure: Effect.raceFirst(
      llm.failure,
      Deferred.await(unexpectedExit),
    ),
  } satisfies Server
})

export * as OpenCodeServer from "./server.js"
