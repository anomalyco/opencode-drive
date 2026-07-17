import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Llm from "../llm/index.js"
import { chunkText } from "../llm/internal.js"
import type { BackendConnection } from "../simulation/connector.js"
import { controllerError, LlmControllerError } from "./llm-errors.js"

/**
 * The wire layer of the LLM controller: plays one `Response` stream onto a
 * backend connection as `llm.chunk` / `llm.finish` / `llm.disconnect` RPCs,
 * chunking text with optional pacing and guaranteeing a terminal event.
 */

/** A stream of simulated model output for one LLM exchange. */
export type Response = Stream.Stream<Llm.Output, LlmControllerError>

export interface Options {
  /** Per-backend-RPC timeout in milliseconds. */
  readonly requestTimeout: number
}

export interface Responder {
  /** Plays one response for one exchange, guaranteeing a terminal event. */
  readonly respond: (
    backend: BackendConnection,
    requestId: string,
    output: Response,
  ) => Effect.Effect<void, LlmControllerError>
}

const decodeOutput = Schema.decodeUnknownEffect(Llm.Output)

export const make = ({ requestTimeout }: Options): Responder => {
  const call = <A, E>(
    operation: string,
    requestId: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, LlmControllerError> =>
    Effect.timeoutOrElse(effect, {
      duration: requestTimeout,
      orElse: () =>
        Effect.fail(
          new LlmControllerError({
            operation,
            requestId,
            message: `${operation} timed out after ${requestTimeout}ms`,
          }),
        ),
    }).pipe(
      Effect.mapError((cause) => controllerError(operation, cause, requestId)),
    )

  const streamDelta = Effect.fn("LlmResponder.streamDelta")(function* (
    backend: BackendConnection,
    id: string,
    type: "textDelta" | "reasoningDelta",
    text: string,
    options: Llm.StreamOptions | undefined,
  ) {
    const delay = options?.delay ?? 2
    const chunkSize = options?.chunkSize ?? 15
    const chunks = [...chunkText(text, chunkSize)]
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]
      if (chunk === undefined) continue
      yield* call(
        "llm.chunk",
        id,
        backend.rpc["llm.chunk"]({ id, items: [{ type, text: chunk }] }),
      )
      if (index < chunks.length - 1 && delay > 0) yield* Effect.sleep(delay)
    }
  })

  const streamToolCall = Effect.fn("LlmResponder.streamToolCall")(function* (
    backend: BackendConnection,
    requestId: string,
    toolCall: Llm.ToolCall,
  ) {
    const delay = toolCall.options?.delay ?? 2
    const chunkSize = toolCall.options?.chunkSize ?? 15
    const chunks = [...chunkText(JSON.stringify(toolCall.input), chunkSize)]
    for (let index = 0; index < chunks.length; index++) {
      const text = chunks[index]
      if (text === undefined) continue
      const callDelta =
        index === 0
          ? {
              index: toolCall.index,
              id: toolCall.id,
              function: { name: toolCall.name, arguments: text },
            }
          : {
              index: toolCall.index,
              function: { arguments: text },
            }
      yield* call(
        "llm.chunk",
        requestId,
        backend.rpc["llm.chunk"]({
          id: requestId,
          items: [
            {
              type: "raw",
              chunk: { choices: [{ delta: { tool_calls: [callDelta] } }] },
            },
          ],
        }),
      )
      if (index < chunks.length - 1 && delay > 0) yield* Effect.sleep(delay)
    }
  })

  const respond = Effect.fn("LlmResponder.respond")(function* (
    backend: BackendConnection,
    requestId: string,
    output: Response,
  ) {
    let terminal = false
    yield* output.pipe(
      Stream.mapEffect((value) => decodeOutput(value)),
      Stream.runForEach((item) => {
        if (terminal)
          return Effect.fail(
            new LlmControllerError({
              operation: "respond",
              requestId,
              message: `LLM response ${requestId} emitted output after its terminal event`,
            }),
          )
        switch (item.type) {
          case "finish":
            terminal = true
            return call(
              "llm.finish",
              requestId,
              backend.rpc["llm.finish"]({
                id: requestId,
                ...(item.reason === undefined ? {} : { reason: item.reason }),
              }),
            ).pipe(Effect.asVoid)
          case "disconnect":
            terminal = true
            return call(
              "llm.disconnect",
              requestId,
              backend.rpc["llm.disconnect"]({ id: requestId }),
            ).pipe(Effect.asVoid)
          case "text":
            return streamDelta(
              backend,
              requestId,
              "textDelta",
              item.text,
              item.options,
            )
          case "reasoning":
            return streamDelta(
              backend,
              requestId,
              "reasoningDelta",
              item.text,
              item.options,
            )
          case "pause":
            return item.milliseconds === 0
              ? Effect.void
              : Effect.sleep(item.milliseconds)
          case "toolCall": {
            if (item.options !== undefined)
              return streamToolCall(backend, requestId, item)
            const { options: _, ...toolCall } = item
            return call(
              "llm.chunk",
              requestId,
              backend.rpc["llm.chunk"]({
                id: requestId,
                items: [toolCall],
              }),
            ).pipe(Effect.asVoid)
          }
          case "raw":
            return call(
              "llm.chunk",
              requestId,
              backend.rpc["llm.chunk"]({ id: requestId, items: [item] }),
            ).pipe(Effect.asVoid)
        }
        return Effect.void
      }),
      Effect.mapError((cause) => controllerError("respond", cause, requestId)),
    )
    if (!terminal)
      yield* call(
        "llm.finish",
        requestId,
        backend.rpc["llm.finish"]({ id: requestId, reason: "stop" }),
      )
  })

  return { respond }
}
