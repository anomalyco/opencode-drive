import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import * as SimulationConnector from "../simulation/connector.js"
import type { UiConnection } from "../simulation/connector.js"
import { Frontend } from "./protocol.js"
import { recordLog } from "../log.js"

const defaultPort = 40900

export interface SimulationClientOptions {
  /** Explicit server URL; skips port scanning. */
  readonly url?: string
  /** First port to try when no URL is given. Defaults to 40900. */
  readonly port?: number
  /** Ports to scan upward from `port`. Defaults to 10. */
  readonly portAttempts?: number
  /** Per-call timeout in milliseconds. Defaults to 30_000. */
  readonly timeout?: number
  readonly onScreenshot?: (path: string) => void
}

export class SimulationError extends Error {
  constructor(
    message: string,
    readonly method?: string,
  ) {
    super(message)
    this.name = "SimulationError"
  }
}

export class SimulationClient {
  readonly url: string

  private closed = false

  private constructor(
    private readonly scope: Scope.Closeable,
    private readonly connection: UiConnection,
    url: string,
    private readonly timeout: number,
    private readonly onScreenshot?: (path: string) => void,
  ) {
    this.url = url
  }

  static async connect(
    options?: SimulationClientOptions,
  ): Promise<SimulationClient> {
    const timeout = options?.timeout ?? 30_000
    if (options?.url !== undefined)
      return SimulationClient.acquire(options.url, timeout, options.onScreenshot)

    const first = options?.port ?? defaultPort
    const attempts = options?.portAttempts ?? 10
    for (let offset = 0; offset < attempts; offset++) {
      const url = `ws://127.0.0.1:${first + offset}`
      try {
        return await SimulationClient.acquire(url, timeout, options?.onScreenshot)
      } catch {
        // Occupied by another service or not listening; try the next port.
      }
    }
    throw new SimulationError(
      `no simulation server found on ports ${first}-${first + attempts - 1}; ` +
        "is OpenCode running with OPENCODE_SIMULATION=1?",
    )
  }

  call(
    method: "ui.screenshot",
    params?: Frontend.ScreenshotParams,
  ): Promise<Frontend.Screenshot>
  call(method: "ui.capture"): Promise<Frontend.CapturedFrame>
  call(method: "ui.state"): Promise<Frontend.State>
  call(
    method: "ui.matches",
    params: Frontend.MatchesParams,
  ): Promise<Frontend.Matches>
  call(method: "ui.recording.finish"): Promise<Frontend.RecordingFinish>
  call(method: "ui.type", params: Frontend.TypeParams): Promise<Frontend.State>
  call(method: "ui.press", params: Frontend.PressParams): Promise<Frontend.State>
  call(method: "ui.enter"): Promise<Frontend.State>
  call(method: "ui.arrow", params: Frontend.ArrowParams): Promise<Frontend.State>
  call(method: "ui.focus", params: Frontend.FocusParams): Promise<Frontend.State>
  call(method: "ui.click", params: Frontend.ClickParams): Promise<Frontend.State>
  call(method: "ui.resize", params: Frontend.ResizeParams): Promise<Frontend.State>
  call(
    method:
      | "ui.screenshot"
      | "ui.capture"
      | "ui.state"
      | "ui.matches"
      | "ui.recording.finish"
      | "ui.type"
      | "ui.press"
      | "ui.enter"
      | "ui.arrow"
      | "ui.focus"
      | "ui.click"
      | "ui.resize",
    params?:
      | Frontend.ScreenshotParams
      | Frontend.MatchesParams
      | Frontend.TypeParams
      | Frontend.PressParams
      | Frontend.ArrowParams
      | Frontend.FocusParams
      | Frontend.ClickParams
      | Frontend.ResizeParams,
  ): Promise<
    Frontend.State | Frontend.Screenshot | Frontend.CapturedFrame | Frontend.Matches
  > {
    if (this.closed)
      return Promise.reject(new SimulationError("connection is not open", method))
    recordLog("INFO", `ui command ${method} params=${formatParams(params)}`)
    try {
      const request = Frontend.decodeRequest({
        jsonrpc: "2.0",
        method,
        ...(params === undefined ? {} : { params }),
      })
      switch (request.method) {
        case "ui.capture":
          return this.run(method, this.connection.rpc["ui.capture"]())
        case "ui.screenshot":
          return this.run(method, this.connection.rpc["ui.screenshot"](request.params))
        case "ui.state":
          return this.run(method, this.connection.rpc["ui.state"]())
        case "ui.matches":
          return this.run(method, this.connection.rpc["ui.matches"](request.params))
        case "ui.recording.finish":
          return this.run(method, this.connection.rpc["ui.recording.finish"]())
        case "ui.type":
          return this.run(method, this.connection.rpc["ui.type"](request.params))
        case "ui.press":
          return this.run(method, this.connection.rpc["ui.press"](request.params))
        case "ui.enter":
          return this.run(method, this.connection.rpc["ui.enter"]())
        case "ui.arrow":
          return this.run(method, this.connection.rpc["ui.arrow"](request.params))
        case "ui.focus":
          return this.run(method, this.connection.rpc["ui.focus"](request.params))
        case "ui.click":
          return this.run(method, this.connection.rpc["ui.click"](request.params))
        case "ui.resize":
          return this.run(method, this.connection.rpc["ui.resize"](request.params))
      }
    } catch (cause) {
      return Promise.reject(
        new SimulationError(
          cause instanceof Error ? cause.message : String(cause),
          method,
        ),
      )
    }
    return Promise.reject(new SimulationError("unknown UI method", method))
  }

  state() {
    return this.call("ui.state")
  }

  capture() {
    return this.call("ui.capture")
  }

  matches(text: string) {
    return this.call("ui.matches", { text })
  }

  async screenshot(name?: string) {
    const path = await this.call(
      "ui.screenshot",
      name === undefined ? undefined : { name },
    )
    this.onScreenshot?.(path)
    return path
  }

  finishRecording() {
    return this.call("ui.recording.finish")
  }

  typeText(text: string) {
    return this.call("ui.type", { text })
  }

  pressKey(key: string, modifiers?: Frontend.KeyModifiers) {
    return this.call("ui.press", Frontend.pressParams(key, modifiers))
  }

  pressEnter() {
    return this.call("ui.enter")
  }

  pressArrow(direction: Frontend.ArrowParams["direction"]) {
    return this.call("ui.arrow", { direction })
  }

  focus(target: number) {
    return this.call("ui.focus", { target })
  }

  click(target: number, x: number, y: number) {
    return this.call("ui.click", { target, x, y })
  }

  resize(viewport: Frontend.ResizeParams) {
    return this.call("ui.resize", viewport)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    Effect.runFork(Scope.close(this.scope, Exit.void))
  }

  private run<A, E>(method: string, effect: Effect.Effect<A, E>): Promise<A> {
    return Effect.runPromise(
      effect.pipe(
        Effect.timeoutOrElse({
          duration: this.timeout,
          orElse: () =>
            Effect.fail(
              new SimulationError(
                `timed out after ${this.timeout}ms`,
                method,
              ),
            ),
        }),
      ),
    ).then((result) => {
      recordLog("INFO", `ui command ${method} completed`)
      return result
    }).catch((cause) => {
      const failure = new SimulationError(
        this.closed ? "connection closed" : legacyMessage(cause),
        method,
      )
      recordLog("ERROR", `ui command ${method} failed: ${failure.message}`)
      throw failure
    })
  }

  private static async acquire(
    url: string,
    timeout: number,
    onScreenshot?: (path: string) => void,
  ) {
    const scope = await Effect.runPromise(Scope.make())
    try {
      const connection = await Effect.runPromise(
        SimulationConnector.ui(url, { connectTimeout: timeout }).pipe(
          Scope.provide(scope),
        ),
      )
      return new SimulationClient(
        scope,
        connection,
        url,
        timeout,
        onScreenshot,
      )
    } catch (cause) {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      throw new SimulationError(
        cause instanceof Error ? cause.message : `cannot connect to ${url}`,
      )
    }
  }
}

function formatParams(params: unknown) {
  return params === undefined ? "undefined" : JSON.stringify(params)
}

function legacyMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (message.includes("connection closed")) return "connection closed"
  if (message.includes("connection error")) return "connection error"
  return message
}

export const connectSimulation = (
  options?: SimulationClientOptions,
): Promise<SimulationClient> => SimulationClient.connect(options)
