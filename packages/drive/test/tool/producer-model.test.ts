import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Queue, Stream } from "effect"
import * as FastCheck from "effect/testing/FastCheck"
import type { ToolEvent } from "../../src/simulation/connector.js"
import { Backend } from "../../src/simulation/protocol.js"
import { SimulationRequestError } from "../../src/simulation/rpc.js"
import * as ToolProducer from "../../src/tool/producer.js"
import type { Invocation } from "../../src/tool/types.js"

const registration = {
  name: "lookup",
  description: "Look up a value",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { answer: { type: "number" } },
    required: ["answer"],
  },
  options: { codemode: false },
} as const

const replacement = {
  ...registration,
  name: "search",
  description: "Search for a value",
} as const

const toolSets = [[], [registration], [replacement]] as const

type Request = {
  readonly method: "attach" | "progress" | "finish" | "fail"
  readonly params: unknown
}

const makeBackend = Effect.fn("ToolProducerModel.makeBackend")(function* (
  generation: number,
) {
  const events = yield* Queue.unbounded<ToolEvent>()
  yield* Effect.addFinalizer(() => Queue.shutdown(events))
  const closed = yield* Deferred.make<void>()
  const requests: Request[] = []
  let rejectNextAttach = false
  const backend = {
    generation,
    endpoint: `memory://tools/${generation}`,
    toolEvents: Stream.fromQueue(events),
    closed: Deferred.await(closed),
    flushToolEvents: () =>
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void>()
        yield* Queue.offer(events, { type: "barrier", completed })
        yield* Deferred.await(completed)
      }),
    attachTools: (tools) =>
      Effect.suspend(() => {
        requests.push({ method: "attach", params: { tools } })
        if (!rejectNextAttach) return Effect.succeed({ attached: true as const })
        rejectNextAttach = false
        return Effect.fail(
          new SimulationRequestError({
            method: "tool.attach",
            code: -32000,
            message: "model rejected attachment",
          }),
        )
      }),
    updateTool: (params) =>
      Effect.sync(() => {
        requests.push({ method: "progress", params })
        return { ok: true as const }
      }),
    finishTool: (params) =>
      Effect.sync(() => {
        requests.push({ method: "finish", params })
        return { ok: true as const }
      }),
    failTool: (params) =>
      Effect.sync(() => {
        requests.push({ method: "fail", params })
        return { ok: true as const }
      }),
  } satisfies ToolProducer.BackendConnection
  const drain = backend.flushToolEvents
  return {
    backend,
    requests,
    close: Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
    rejectAttach: () => {
      rejectNextAttach = true
    },
    invocation: (value: Backend.ToolInvocation) =>
      Queue.offer(events, { type: "invocation", invocation: value }).pipe(
        Effect.andThen(drain()),
      ),
    cancel: (id: string) =>
      Queue.offer(events, {
        type: "cancellation",
        cancellation: { id, reason: "interrupted" },
      }).pipe(Effect.andThen(drain())),
  }
})

type ModelCall = {
  readonly invocation: Backend.ToolInvocation
  call?: Invocation
  sequence: number
  state: "pending" | "settled" | "cancelled"
}

const actionArbitrary = FastCheck.record({
  kind: FastCheck.constantFrom(
    "attach",
    "rejectAttach",
    "disconnect",
    "reconnect",
    "invoke",
    "take",
    "progress",
    "finish",
    "fail",
    "cancel",
    "endGeneration",
  ),
  slot: FastCheck.integer({ min: 0, max: 5 }),
  value: FastCheck.integer({ min: 0, max: 2 }),
})

it.effect.prop(
  "preserves lifecycle invariants across generated operation sequences",
  { actions: FastCheck.array(actionArbitrary, { minLength: 1, maxLength: 40 }) },
  ({ actions }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const controller = yield* ToolProducer.make(new Set())
        let generation = 0
        let harness = yield* makeBackend(generation)
        const initial = yield* controller.connectFrom(
          Effect.succeed(harness.backend),
        )
        expect(initial.backend.generation).toBe(0)
        let attachment: ToolProducer.BackendAttachment | undefined =
          initial.attachment
        let generationActive = true
        let accepted: (typeof toolSets)[number] | undefined
        const calls = new Map<number, ModelCall>()

        for (const action of actions) {
          if (action.kind === "attach" && attachment !== undefined) {
            const tools = toolSets[action.value]
            yield* controller.controls.attach({ tools })
            accepted = tools
            expect(harness.requests.at(-1)).toEqual({
              method: "attach",
              params: { tools },
            })
            continue
          }
          if (action.kind === "rejectAttach" && attachment !== undefined) {
            const previous = accepted
            harness.rejectAttach()
            expect(
              yield* controller.controls
                .attach({ tools: toolSets[action.value] })
                .pipe(Effect.flip),
            ).toMatchObject({ operation: "attach", reason: "rejected" })
            accepted = previous
            continue
          }
          if (action.kind === "disconnect" && attachment !== undefined) {
            yield* harness.close
            yield* attachment.detach()
            attachment = undefined
            continue
          }
          if (action.kind === "reconnect" && attachment === undefined) {
            harness = yield* makeBackend(++generation)
            attachment = yield* controller.connect(harness.backend)
            generationActive = true
            expect(harness.requests).toEqual(
              accepted === undefined
                ? []
                : [{ method: "attach", params: { tools: accepted } }],
            )
            continue
          }
          if (action.kind === "endGeneration") {
            const pendingClaims = Array.from(calls.values()).flatMap(
              (call) =>
                call.state === "pending" && call.call !== undefined
                  ? [{ invocation: call.invocation, call: call.call }]
                  : [],
            )
            yield* controller.endGeneration
            attachment = undefined
            generationActive = false
            for (const call of pendingClaims)
              expect(yield* call.call.awaitCancelled()).toMatchObject({
                id: call.invocation.id,
                reason: "interrupted",
              })
            calls.clear()
            continue
          }

          const current = calls.get(action.slot)
          if (action.kind === "invoke" && attachment !== undefined) {
            const value =
              current?.invocation ??
              ({
                id: `tool_${action.slot}`,
                name: "lookup",
                input: { query: `query_${action.slot}` },
                context: {
                  sessionID: "ses_model",
                  agent: "build",
                  messageID: "msg_model",
                  callID: `call_${action.slot}`,
                },
              } satisfies Backend.ToolInvocation)
            yield* harness.invocation(value)
            if (current === undefined)
              calls.set(action.slot, {
                invocation: value,
                sequence: 0,
                state: "pending",
              })
            continue
          }
          if (current === undefined) continue
          if (
            action.kind === "take" &&
            current.call === undefined &&
            current.state !== "settled"
          ) {
            current.call = yield* controller.controls.take(
              current.invocation.context.callID,
            )
            continue
          }
          if (
            action.kind === "cancel" &&
            attachment !== undefined &&
            current.state === "pending"
          ) {
            yield* harness.cancel(current.invocation.id)
            current.state = "cancelled"
            continue
          }
          if (
            (action.kind === "progress" ||
              action.kind === "finish" ||
              action.kind === "fail") &&
            current.call !== undefined &&
            current.state !== "pending"
          ) {
            const error = yield* (action.kind === "progress"
              ? current.call.progress({ structured: { step: action.value } })
              : action.kind === "finish"
                ? current.call.finish({ structured: { answer: action.value } })
                : current.call.fail(`failure_${action.value}`)
            ).pipe(Effect.flip)
            expect(error).toMatchObject({
              operation: action.kind,
              reason:
                current.state === "settled"
                  ? "already-settled"
                  : "cancelled",
              callID: current.invocation.context.callID,
            })
            continue
          }
          if (
            action.kind === "progress" &&
            attachment !== undefined &&
            current.call !== undefined &&
            current.state === "pending"
          ) {
            yield* current.call.progress({ structured: { step: action.value } })
            expect(harness.requests.at(-1)).toEqual({
              method: "progress",
              params: {
                id: current.invocation.id,
                sequence: current.sequence,
                update: { structured: { step: action.value } },
              },
            })
            current.sequence++
            continue
          }
          if (
            (action.kind === "finish" || action.kind === "fail") &&
            attachment !== undefined &&
            current.call !== undefined &&
            current.state === "pending"
          ) {
            if (action.kind === "finish")
              yield* current.call.finish({
                structured: { answer: action.value },
                content: [],
              })
            else yield* current.call.fail(`failure_${action.value}`)
            expect(harness.requests.at(-1)).toEqual(
              action.kind === "finish"
                ? {
                    method: "finish",
                    params: {
                      id: current.invocation.id,
                      output: {
                        structured: { answer: action.value },
                        content: [],
                      },
                    },
                  }
                : {
                    method: "fail",
                    params: {
                      id: current.invocation.id,
                      message: `failure_${action.value}`,
                    },
                  },
            )
            current.state = "settled"
          }
        }

        if (attachment === undefined && generationActive) {
          harness = yield* makeBackend(++generation)
          attachment = yield* controller.connect(harness.backend)
        }
        const pending = Array.from(calls.values()).filter(
          (call) => call.state === "pending",
        )
        if (pending.length > 0) {
          expect(yield* controller.settle.pipe(Effect.flip)).toMatchObject({
            operation: "take",
            reason: "rejected",
            message: `${pending.length} dynamic tool invocation(s) remain unsettled`,
          })
          expect(
            yield* controller.controls
              .attach({ tools: [] })
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "controller-closed" })
          for (const call of pending) {
            yield* harness.cancel(call.invocation.id)
            call.state = "cancelled"
          }
        }
        yield* controller.settle

        let backendFactories = 0
        expect(
          yield* controller
            .connectFrom(
              Effect.sync(() => {
                backendFactories++
                return harness.backend
              }),
            )
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "controller-closed" })
        expect(backendFactories).toBe(0)
      }),
    ),
  { fastCheck: { numRuns: 250 }, timeout: 30_000 },
)

it.effect.prop(
  "keeps unclaimed cancellation retention bounded",
  { count: FastCheck.integer({ min: 257, max: 280 }) },
  ({ count }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const controller = yield* ToolProducer.make(new Set())
        const harness = yield* makeBackend(0)
        yield* controller.connect(harness.backend)

        for (let index = 0; index < count; index++) {
          yield* harness.invocation({
            id: `tool_${index}`,
            name: "lookup",
            input: { query: String(index) },
            context: {
              sessionID: "ses_retention",
              agent: "build",
              messageID: "msg_retention",
              callID: `call_${index}`,
            },
          })
          yield* harness.cancel(`tool_${index}`)
        }

        const latest = yield* controller.controls.take(`call_${count - 1}`)
        expect(yield* latest.awaitCancelled()).toMatchObject({
          id: `tool_${count - 1}`,
        })
        const oldest = yield* controller.controls
          .take("call_0")
          .pipe(Effect.forkScoped)
        yield* harness.invocation({
          id: "tool_0",
          name: "lookup",
          input: { query: "0" },
          context: {
            sessionID: "ses_retention",
            agent: "build",
            messageID: "msg_retention",
            callID: "call_0",
          },
        })
        const recycled = yield* Fiber.join(oldest)
        expect(recycled.id).toBe("tool_0")
        yield* recycled.finish({ structured: { answer: 0 }, content: [] })
        yield* controller.settle
      }),
    ),
  { fastCheck: { numRuns: 20 }, timeout: 30_000 },
)
