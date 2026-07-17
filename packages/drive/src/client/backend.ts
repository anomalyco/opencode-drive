import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Scope from "effect/Scope"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as SimulationConnector from "../simulation/connector.js"
import type { BackendConnection } from "../simulation/connector.js"
import { Backend } from "./protocol.js"
import { logError } from "../log.js"

const defaultBackendPort = 40950

export interface BackendSimulationClientOptions {
  readonly url?: string
  readonly port?: number
  readonly portAttempts?: number
  readonly timeout?: number
  readonly compatibility?: SimulationConnector.CompatibilityPolicy
}

export class BackendSimulationError extends Error {
  constructor(
    message: string,
    readonly method?: string,
  ) {
    super(message)
    this.name = "BackendSimulationError"
  }
}

export class BackendSimulationClient {
  readonly url: string
  readonly closed: Promise<void>

  private closing = false
  private attached = false
  private readonly resolveClosed: () => void
  private readonly listeners = new Set<
    (request: Backend.OpenedExchange) => void | Promise<void>
  >()

  private constructor(
    private readonly scope: Scope.Closeable,
    private readonly connection: BackendConnection,
    url: string,
    private readonly timeout: number,
  ) {
    this.url = url
    const closed = Promise.withResolvers<void>()
    this.closed = closed.promise
    this.resolveClosed = closed.resolve
    Effect.runFork(
      connection.closed.pipe(
        Effect.tap(() => Effect.sync(closed.resolve)),
        Effect.forkIn(scope),
      ),
    )
  }

  static async connect(
    options?: BackendSimulationClientOptions,
  ): Promise<BackendSimulationClient> {
    const timeout = options?.timeout ?? 30_000
    if (options?.url !== undefined)
      return BackendSimulationClient.acquire(
        options.url,
        timeout,
        options.compatibility,
      )

    const first = options?.port ?? defaultBackendPort
    const attempts = options?.portAttempts ?? 10
    for (let offset = 0; offset < attempts; offset++) {
      const url = `ws://127.0.0.1:${first + offset}`
      try {
        return await BackendSimulationClient.acquire(
          url,
          timeout,
          options?.compatibility,
        )
      } catch {
        // Occupied by another service or not listening; try the next port.
      }
    }
    throw new BackendSimulationError(
      `no backend simulation server found on ports ${first}-${first + attempts - 1}`,
    )
  }

  call(method: "llm.attach"): Promise<Backend.Attached>
  call(method: "llm.chunk", params: Backend.ChunkParams): Promise<Backend.Ok>
  call(method: "llm.finish", params: Backend.FinishPayload): Promise<Backend.Ok>
  call(
    method: "llm.disconnect",
    params: Backend.DisconnectParams,
  ): Promise<Backend.Ok>
  call(
    method: "llm.attach" | "llm.chunk" | "llm.finish" | "llm.disconnect",
    params?:
      | Backend.ChunkParams
      | Backend.FinishPayload
      | Backend.DisconnectParams,
  ): Promise<Backend.Attached | Backend.Ok> {
    if (this.closing)
      return Promise.reject(
        new BackendSimulationError("connection is not open", method),
      )
    try {
      switch (method) {
        case "llm.attach":
          return this.run(method, this.connection.attach())
        case "llm.chunk": {
          const value = Schema.decodeUnknownSync(Backend.ChunkParams)(params)
          return this.run(method, this.connection.rpc["llm.chunk"](value))
        }
        case "llm.finish": {
          const value = Schema.decodeUnknownSync(Backend.FinishPayload)(params)
          return this.run(method, this.connection.rpc["llm.finish"](value))
        }
        case "llm.disconnect": {
          const value = Schema.decodeUnknownSync(Backend.DisconnectParams)(params)
          return this.run(
            method,
            this.connection.rpc["llm.disconnect"](value),
          )
        }
      }
    } catch (cause) {
      return Promise.reject(
        new BackendSimulationError(
          cause instanceof Error ? cause.message : String(cause),
          method,
        ),
      )
    }
    return Promise.reject(new BackendSimulationError("unknown backend method", method))
  }

  async attach(
    onRequest: (request: Backend.OpenedExchange) => void | Promise<void>,
  ) {
    this.listeners.add(onRequest)
    if (!this.attached) {
      this.attached = true
      const worker = await Effect.runPromise(
        this.connection.requests.pipe(
          Stream.runForEach((request) =>
            Effect.forEach(
              this.listeners,
              (listener) =>
                Effect.try({
                  try: () => listener(request),
                  catch: (cause) => cause,
                }).pipe(
                  Effect.flatMap((result) =>
                    Effect.tryPromise({
                      try: () => Promise.resolve(result),
                      catch: (cause) => cause,
                    }).pipe(Effect.forkIn(this.scope)),
                  ),
                  Effect.catch((cause) =>
                    this.closing
                      ? Effect.void
                      : Effect.sync(() =>
                          logError(
                            cause instanceof Error
                              ? cause.message
                              : String(cause),
                          ),
                        ),
                  ),
                ),
              { discard: true },
            ),
          ),
          Effect.forkIn(this.scope),
        ),
      )
      try {
        await this.call("llm.attach")
      } catch (cause) {
        await Effect.runPromise(Fiber.interrupt(worker))
        this.attached = false
        this.listeners.delete(onRequest)
        throw cause
      }
    }
    return { attached: true as const }
  }

  chunk(id: string, items: ReadonlyArray<Backend.Item>) {
    return this.call("llm.chunk", { id, items })
  }

  finish(id: string, reason?: Backend.FinishReason) {
    return this.call("llm.finish", {
      id,
      ...(reason === undefined ? {} : { reason }),
    })
  }

  disconnect(id: string) {
    return this.call("llm.disconnect", { id })
  }

  close() {
    if (this.closing) return
    this.closing = true
    Effect.runFork(
      Scope.close(this.scope, Exit.void).pipe(
        Effect.tap(() => Effect.sync(this.resolveClosed)),
      ),
    )
  }

  private run<A, E>(method: string, effect: Effect.Effect<A, E>): Promise<A> {
    return Effect.runPromise(
      effect.pipe(
        Effect.timeoutOrElse({
          duration: this.timeout,
          orElse: () =>
            Effect.fail(
              new BackendSimulationError(
                `timed out after ${this.timeout}ms`,
                method,
              ),
            ),
        }),
      ),
    ).catch((cause) => {
      throw new BackendSimulationError(
        this.closing ? "connection closed" : legacyMessage(cause),
        method,
      )
    })
  }

  private static async acquire(
    url: string,
    timeout: number,
    compatibility?: SimulationConnector.CompatibilityPolicy,
  ) {
    const scope = await Effect.runPromise(Scope.make())
    try {
      const connection = await Effect.runPromise(
        SimulationConnector.backend(url, {
          connectTimeout: timeout,
          requestTimeout: timeout,
          attach: false,
          compatibility,
        }).pipe(Scope.provide(scope)),
      )
      return new BackendSimulationClient(scope, connection, url, timeout)
    } catch (cause) {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      throw new BackendSimulationError(
        cause instanceof Error ? cause.message : `cannot connect to ${url}`,
      )
    }
  }
}

function legacyMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (message.includes("connection closed")) return "connection closed"
  if (message.includes("connection error")) return "connection error"
  return message
}

export const connectBackendSimulation = (
  options?: BackendSimulationClientOptions,
): Promise<BackendSimulationClient> => BackendSimulationClient.connect(options)
