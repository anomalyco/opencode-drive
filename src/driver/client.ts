import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Ref from "effect/Ref"
import * as Semaphore from "effect/Semaphore"
import * as Scope from "effect/Scope"
import * as Deferred from "effect/Deferred"
import type * as OpenCodeInstance from "../instance/runtime.js"
import type * as SimulationConnector from "../simulation/connector.js"
import { finalizeRecording } from "../recording/finalize.js"
import { error, type OpenCodeDriverError } from "./error.js"
import * as OpenCodeUi from "./ui.js"
import * as SharedEffect from "./shared.js"

export interface Options {
  readonly recording?: boolean
  readonly viewport?: import("../script/types.js").UiViewport
}

export interface Client {
  readonly ui: OpenCodeUi.Ui
  readonly recording?: Recording
  readonly close: () => Effect.Effect<void>
}

export interface Recording {
  readonly path: string
  readonly timeline: string
  readonly finish: () => Effect.Effect<
    string,
    OpenCodeDriverError | OpenCodeUi.OperationError
  >
}

interface ManagedClient extends Client {
  readonly _exitCode: Effect.Effect<number, OpenCodeDriverError>
  readonly _recording?: {
    readonly finishTimeline: Effect.Effect<
      string,
      OpenCodeDriverError | OpenCodeUi.OperationError
    >
    readonly exportRecording: Effect.Effect<
      string,
      OpenCodeDriverError | OpenCodeUi.OperationError
    >
  }
}

export const make = Effect.fn("OpenCodeClient.make")(function* (
  instance: OpenCodeInstance.Instance,
  visible: boolean,
  identity: string,
  options: Options,
  connector: SimulationConnector.Interface,
) {
  if (visible && options.recording)
    return yield* Effect.fail(
      error(
        "client.launch",
        "recording requires a headless OpenCode client",
      ),
    )
  const launched = yield* Effect.acquireRelease(
    instance.launchClient(identity, {
      record: options.recording,
      viewport: options.viewport,
    }).pipe(
      Effect.mapError((cause) => error("client.launch", cause)),
    ),
    (client) =>
      client.close.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("OpenCode client cleanup failed", cause),
        ),
      ),
  )
  const connection = yield* connector.ui(launched.endpoint)
  const ui = OpenCodeUi.make(connection)
  yield* ui.waitFor((state) => state.focused.editor, {
    timeout: 30_000,
    interval: 50,
  })

  const recording = launched.recording
  let managedRecording: ManagedClient["_recording"]
  if (recording !== undefined) {
    const finishTimeline = yield* SharedEffect.make(
      Effect.gen(function* () {
        const timeline = yield* ui.finishRecording()
        if (timeline !== recording.timeline)
          return yield* Effect.fail(
            error(
              "recording.finish",
              `OpenCode returned an unexpected recording path: ${timeline}`,
            ),
          )
        return timeline
      }),
    )
    const exportFinishedRecording = yield* SharedEffect.make(
      Effect.flatMap(finishTimeline, (timeline) =>
        Effect.tryPromise({
          try: (signal) => finalizeRecording(timeline, recording, { signal }),
          catch: (cause) => error("recording.export", cause),
        }),
      ),
    )
    managedRecording = {
      finishTimeline,
      exportRecording: exportFinishedRecording,
    }
    yield* Effect.addFinalizer(() =>
      finishTimeline.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logError("OpenCode client recording finalization failed", cause),
        ),
      ),
    )
  }

  return {
    ui,
    close: () => Effect.void,
    _exitCode: launched.process.exitCode.pipe(
      Effect.mapError((cause) => error("client.exit", cause)),
    ),
    ...(recording === undefined || managedRecording === undefined
      ? {}
      : {
          recording: {
            path: recording.video,
            timeline: recording.timeline,
            finish: () => managedRecording.exportRecording,
          },
          _recording: managedRecording,
        }),
  } satisfies ManagedClient
})

export interface Clients {
  readonly make: (
    options?: Options,
  ) => Effect.Effect<
    Client,
    | OpenCodeDriverError
    | OpenCodeUi.OperationError
    | OpenCodeUi.UiWaitOptionsError
  >
  /** Launches a named client. The name is released when that client closes. */
  readonly launch: (
    name: string,
    options?: Options,
  ) => Effect.Effect<
    Client,
    | OpenCodeDriverError
    | OpenCodeUi.OperationError
    | OpenCodeUi.UiWaitOptionsError
  >
}

export interface UnexpectedExit {
  readonly name: string
  readonly status: number
}

export interface Control extends Clients {
  readonly unexpectedExit: Effect.Effect<UnexpectedExit>
  readonly finish: () => Effect.Effect<
    void,
    OpenCodeDriverError | OpenCodeUi.OperationError
  >
  readonly settle: () => Effect.Effect<
    ReadonlyArray<string>,
    OpenCodeDriverError | OpenCodeUi.OperationError
  >
}

export const makeClients = Effect.fn("OpenCodeClients.make")(function* (
  instance: OpenCodeInstance.Instance,
  visible: boolean,
  connector: SimulationConnector.Interface,
) {
  const parentScope = yield* Scope.Scope
  const clientsScope = yield* Scope.fork(parentScope, "parallel")
  const lock = yield* Semaphore.make(1)
  const closed = yield* Ref.make(false)
  const recordings = yield* Ref.make<
    ReadonlyArray<{
      readonly finishTimeline: Effect.Effect<
        string,
        OpenCodeDriverError | OpenCodeUi.OperationError
      >
      readonly exportRecording: Effect.Effect<
        string,
        OpenCodeDriverError | OpenCodeUi.OperationError
      >
    }>
  >([])
  const nextIdentity = yield* Ref.make(0)
  const active = yield* Ref.make<ReadonlyMap<string, Scope.Scope>>(
    new Map(),
  )
  const unexpectedExit = yield* Deferred.make<UnexpectedExit>()

  const launch = Effect.fn("OpenCodeClients.launch")(function* (
    identity: string,
    options: Options = {},
  ) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        if (yield* Ref.get(closed))
          return yield* Effect.fail(
            error("client.make", "OpenCode clients are closed"),
          )
        if ((yield* Ref.get(active)).has(identity))
          return yield* Effect.fail(
            error("client.launch", `client "${identity}" is already connected`),
          )
        const scope = yield* Scope.fork(clientsScope)
        yield* Ref.update(active, (current) =>
          new Map(current).set(identity, scope),
        )
        const client = yield* make(
          instance,
          visible,
          identity,
          options,
          connector,
        ).pipe(
          Scope.provide(scope),
          Effect.onError(() =>
            Ref.update(active, (current) => {
              const next = new Map(current)
              next.delete(identity)
              return next
            }).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
          ),
        )
        const recording = client._recording
        if (recording !== undefined) {
          yield* Ref.update(recordings, (active) => [
            ...active,
            recording,
          ])
        }
        const close = lock.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(active)
            if (current.get(identity) !== scope) return
            const next = new Map(current)
            next.delete(identity)
            yield* Ref.set(active, next)
            yield* Scope.close(scope, Exit.void)
          }),
        )
        yield* client._exitCode.pipe(
          Effect.flatMap((status) =>
            lock.withPermit(
              Effect.gen(function* () {
                const current = yield* Ref.get(active)
                if (current.get(identity) !== scope) return
                const next = new Map(current)
                next.delete(identity)
                yield* Ref.set(active, next)
                yield* Deferred.succeed(unexpectedExit, {
                  name: identity,
                  status,
                })
              }),
            ),
          ),
          Effect.catchCause(() => Effect.void),
          Effect.forkIn(clientsScope),
        )
        const publicClient: Client = {
          ui: client.ui,
          ...(client.recording === undefined
            ? {}
            : { recording: client.recording }),
          close: () => close,
        }
        return publicClient
      }),
    )
  })

  const makeClient = Effect.fn("OpenCodeClients.makeClient")((
    options: Options = {},
  ) =>
    Ref.getAndUpdate(nextIdentity, (value) => value + 1).pipe(
      Effect.flatMap((identity) => launch(`client-${identity}`, options)),
    ))

  const finishTimelines = yield* SharedEffect.make(
    Effect.gen(function* () {
      const active = yield* lock.withPermit(
        Effect.gen(function* () {
          yield* Ref.set(closed, true)
          return yield* Ref.get(recordings)
        }),
      )
      const finished = yield* Effect.forEach(active, (recording) =>
        Effect.exit(recording.finishTimeline), {
        concurrency: "unbounded",
      })
      yield* Scope.close(clientsScope, Exit.void)
      return { active, finished }
    }),
  )

  const finish = Effect.fn("OpenCodeClients.finish")(function* () {
    const { finished } = yield* finishTimelines
    let failure: Cause.Cause<
      OpenCodeDriverError | OpenCodeUi.OperationError
    > | undefined
    for (const result of finished) {
      if (!Exit.isFailure(result)) continue
      failure = failure === undefined
        ? result.cause
        : Cause.combine(failure, result.cause)
    }
    if (failure !== undefined) return yield* Effect.failCause(failure)
    return undefined
  })

  const settle = Effect.fn("OpenCodeClients.settle")(function* () {
    const { active, finished } = yield* finishTimelines
    const exported = yield* Effect.forEach(active, (recording, index) =>
      Exit.isSuccess(finished[index]!)
        ? Effect.exit(recording.exportRecording).pipe(
            Effect.map((result): Exit.Exit<
              string | undefined,
              OpenCodeDriverError | OpenCodeUi.OperationError
            > => result),
          )
        : Effect.succeed(Exit.succeed<string | undefined>(undefined)), {
      concurrency: 2,
    })
    let failure: Cause.Cause<
      OpenCodeDriverError | OpenCodeUi.OperationError
    > | undefined
    for (const result of [...finished, ...exported]) {
      if (!Exit.isFailure(result)) continue
      failure = failure === undefined
        ? result.cause
        : Cause.combine(failure, result.cause)
    }
    if (failure !== undefined)
      return yield* Effect.failCause(failure)
    return exported.flatMap((result) =>
      Exit.isSuccess(result) && result.value !== undefined
        ? [result.value]
        : [],
    )
  })

  return {
    make: makeClient,
    launch,
    unexpectedExit: Deferred.await(unexpectedExit),
    finish,
    settle,
  } satisfies Control
})

export * as OpenCodeClient from "./client.js"
