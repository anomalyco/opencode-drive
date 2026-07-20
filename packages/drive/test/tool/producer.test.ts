import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import * as SimulationConnector from "../../src/simulation/connector.js"
import * as ToolProducer from "../../src/tool/producer.js"
import type { Progress } from "../../src/tool/types.js"
import { sendError, sendResult, startTransportPeer } from "../simulation/transport-peer.js"

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

const invocation = {
  id: "tool_1",
  name: "lookup",
  input: { query: "meaning" },
  context: {
    sessionID: "ses_tools",
    agent: "build",
    messageID: "msg_tools",
    callID: "call_lookup",
  },
} as const

function notify(socket: Bun.ServerWebSocket<undefined>, method: "tool.invocation" | "tool.cancel", params: unknown) {
  socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }))
}

it.live("attaches, sequences progress, and settles one dynamic invocation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = startTransportPeer(({ request, socket }) => {
        sendResult(socket, request, request.method === "tool.attach" ? { attached: true } : { ok: true })
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => peer.stop()))
      const backend = yield* SimulationConnector.backend(peer.url, {
        attach: false,
      })
      const controller = yield* ToolProducer.make(new Set())
      yield* controller.connect(backend)

      yield* controller.controls.attach({ tools: [registration] })
      const socket = peer.received[0].socket
      notify(socket, "tool.invocation", invocation)
      const call = yield* controller.controls.take("call_lookup")

      expect(call).toMatchObject(invocation)
      yield* call.progress({
        structured: { phase: "searching" },
        content: [{ type: "text", text: "Searching" }],
      })
      yield* call.progress({ structured: { phase: "done" } })
      yield* call.finish({
        structured: { answer: 42 },
        content: [{ type: "text", text: "42" }],
      })

      expect(peer.received.map(({ request }) => request)).toEqual([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tool.attach",
          params: { tools: [registration] },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tool.update",
          params: {
            id: "tool_1",
            sequence: 0,
            update: {
              structured: { phase: "searching" },
              content: [{ type: "text", text: "Searching" }],
            },
          },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tool.update",
          params: {
            id: "tool_1",
            sequence: 1,
            update: { structured: { phase: "done" } },
          },
        },
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tool.finish",
          params: {
            id: "tool_1",
            output: {
              structured: { answer: 42 },
              content: [{ type: "text", text: "42" }],
            },
          },
        },
      ])
      expect(yield* call.fail("late").pipe(Effect.flip)).toMatchObject({
        _tag: "OpenCodeDrive.ToolLifecycleError",
        operation: "fail",
        reason: "already-settled",
        callID: "call_lookup",
      })
      yield* controller.settle
    }),
  ),
)

it.live("observes cancellation and rejects terminal work after it wins", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = startTransportPeer(({ request, socket }) =>
        sendResult(socket, request, request.method === "tool.attach" ? { attached: true } : { ok: true }),
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => peer.stop()))
      const backend = yield* SimulationConnector.backend(peer.url, {
        attach: false,
      })
      const controller = yield* ToolProducer.make(new Set())
      yield* controller.connect(backend)
      yield* controller.controls.attach({ tools: [registration] })
      const socket = peer.received[0].socket
      notify(socket, "tool.invocation", invocation)
      notify(socket, "tool.cancel", { id: "tool_1", reason: "interrupted" })
      yield* Effect.sleep(10)
      const call = yield* controller.controls.take("call_lookup")
      const cancelled = yield* call.awaitCancelled().pipe(Effect.forkScoped)

      expect(yield* Fiber.join(cancelled)).toEqual({
        id: "tool_1",
        reason: "interrupted",
      })
      expect(yield* call.finish({ structured: 42, content: [] }).pipe(Effect.flip)).toMatchObject({
        operation: "finish",
        reason: "cancelled",
        callID: "call_lookup",
      })
      yield* controller.settle
    }),
  ),
)

it.live("settles concurrent invocations in controlled reverse order", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = startTransportPeer(({ request, socket }) =>
        sendResult(socket, request, request.method === "tool.attach" ? { attached: true } : { ok: true }),
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => peer.stop()))
      const backend = yield* SimulationConnector.backend(peer.url, { attach: false })
      const controller = yield* ToolProducer.make(new Set())
      yield* controller.connect(backend)
      yield* controller.controls.attach({ tools: [registration] })
      const socket = peer.received[0].socket
      notify(socket, "tool.invocation", invocation)
      notify(socket, "tool.invocation", {
        ...invocation,
        id: "tool_2",
        input: { query: "second" },
        context: { ...invocation.context, callID: "call_second" },
      })

      const second = yield* controller.controls.take("call_second")
      const first = yield* controller.controls.take("call_lookup")
      const start = yield* Deferred.make<void>()
      const attempts = yield* Effect.all(
        [
          Deferred.await(start).pipe(
            Effect.andThen(second.finish({ structured: 2, content: [] })),
            Effect.exit,
          ),
          Deferred.await(start).pipe(
            Effect.andThen(second.fail("second failed")),
            Effect.exit,
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkScoped)
      yield* Deferred.succeed(start, undefined)
      const exits = yield* Fiber.join(attempts)
      expect(exits.filter(Exit.isSuccess)).toHaveLength(1)
      expect(exits.filter(Exit.isFailure)).toHaveLength(1)
      yield* first.fail("first failed")

      const terminals = peer.received.filter(({ request }) =>
        request.method === "tool.finish" || request.method === "tool.fail",
      )
      expect(terminals).toHaveLength(2)
      expect(terminals[0]?.request.params).toMatchObject({ id: "tool_2" })
      expect(terminals[1]?.request).toMatchObject({
        method: "tool.fail",
        params: { id: "tool_1", message: "first failed" },
      })
      yield* controller.settle
    }),
  ),
)

it.live("reattaches the desired set and deduplicates replay after reconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let attaches = 0
      const peer = startTransportPeer(({ request, socket }) => {
        if (request.method === "tool.attach") {
          attaches++
          if (attaches === 2) notify(socket, "tool.invocation", invocation)
          sendResult(socket, request, { attached: true })
          return
        }
        sendResult(socket, request, { ok: true })
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => peer.stop()))
      const controller = yield* ToolProducer.make(new Set())
      const firstScope = yield* Scope.make()
      const first = yield* SimulationConnector.backend(peer.url, {
        attach: false,
      }).pipe(Scope.provide(firstScope))
      const firstAttachment = yield* controller.connect(first)
      yield* controller.controls.attach({ tools: [registration] })
      notify(peer.received[0].socket, "tool.invocation", invocation)
      const call = yield* controller.controls.take("call_lookup")

      yield* firstAttachment.detach()
      yield* Scope.close(firstScope, Exit.void)
      const secondScope = yield* Scope.make()
      const second = yield* SimulationConnector.backend(peer.url, {
        attach: false,
      }).pipe(Scope.provide(secondScope))
      const secondAttachment = yield* controller.connect(second)

      expect(yield* controller.controls.take("call_lookup").pipe(Effect.flip)).toMatchObject({
        reason: "already-claimed",
      })
      yield* call.finish({
        structured: { answer: 42 },
        content: [{ type: "text", text: "42" }],
      })
      expect(attaches).toBe(2)
      expect(peer.received.filter(({ request }) => request.method === "tool.finish")).toHaveLength(1)
      yield* controller.settle
      yield* secondAttachment.detach()
      yield* Scope.close(secondScope, Exit.void)
      yield* controller.endGeneration
      yield* controller.shutdown
    }),
  ),
)

it.live("replays a replacement intent started while disconnected", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = startTransportPeer(({ request, socket }) =>
        sendResult(socket, request, { attached: true }),
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => peer.stop()))
      const controller = yield* ToolProducer.make(new Set())
      const firstScope = yield* Scope.make()
      const first = yield* SimulationConnector.backend(peer.url, {
        attach: false,
      }).pipe(Scope.provide(firstScope))
      const firstAttachment = yield* controller.connect(first)
      yield* controller.controls.attach({ tools: [registration] })
      yield* firstAttachment.detach()
      yield* Scope.close(firstScope, Exit.void)

      const replacement = {
        ...registration,
        name: "search",
        description: "Search for a value",
      }
      const replacing = yield* controller.controls
        .attach({ tools: [replacement] })
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      const secondScope = yield* Scope.make()
      const second = yield* SimulationConnector.backend(peer.url, {
        attach: false,
      }).pipe(Scope.provide(secondScope))
      const secondAttachment = yield* controller.connect(second)
      yield* Fiber.join(replacing)

      expect(
        peer.received
          .filter(({ request }) => request.method === "tool.attach")
          .map(({ request }) => request.params),
      ).toEqual([
        { tools: [registration] },
        { tools: [replacement] },
        { tools: [replacement] },
      ])
      yield* secondAttachment.detach()
      yield* Scope.close(secondScope, Exit.void)
    }),
  ),
)

it.live("preserves a replacement intent when its acknowledgement is lost", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let attaches = 0
      const replacement = {
        ...registration,
        name: "search",
        description: "Search for a value",
      }
      const replacementInvocation = {
        ...invocation,
        id: "tool_2",
        name: "search",
        context: { ...invocation.context, callID: "call_search" },
      }
      const firstReplacement = yield* Deferred.make<void>()
      const peer = startTransportPeer(({ request, socket }) => {
        if (request.method === "tool.attach") {
          attaches++
          if (attaches === 2) {
            notify(socket, "tool.invocation", replacementInvocation)
            Deferred.doneUnsafe(firstReplacement, Effect.void)
            socket.close()
            return
          }
          if (attaches === 3) notify(socket, "tool.invocation", replacementInvocation)
          sendResult(socket, request, { attached: true })
          return
        }
        sendResult(socket, request, { ok: true })
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          void peer.stop()
        }),
      )
      const controller = yield* ToolProducer.make(new Set())
      const firstScope = yield* Scope.make()
      const first = yield* SimulationConnector.backend(peer.url, {
        attach: false,
      }).pipe(Scope.provide(firstScope))
      const firstAttachment = yield* controller.connect(first)
      yield* controller.controls.attach({ tools: [registration] })

      const replacing = yield* controller.controls
        .attach({ tools: [replacement] })
        .pipe(Effect.forkScoped)
      yield* Deferred.await(firstReplacement)
      yield* first.closed
      yield* firstAttachment.detach()
      yield* Scope.close(firstScope, Exit.void)
      const secondScope = yield* Scope.make()
      const second = yield* SimulationConnector.backend(peer.url, {
        attach: false,
      }).pipe(Scope.provide(secondScope))
      const secondAttachment = yield* controller.connect(second)
      yield* Fiber.join(replacing)
      const call = yield* controller.controls.take("call_search")
      yield* call.fail("finished")

      expect(
        peer.received
          .filter(({ request }) => request.method === "tool.attach")
          .map(({ request }) => request.params),
      ).toEqual([
        { tools: [registration] },
        { tools: [replacement] },
        { tools: [replacement] },
        { tools: [replacement] },
      ])
      yield* secondAttachment.detach()
      yield* Scope.close(secondScope, Exit.void)
      yield* controller.endGeneration
      yield* controller.shutdown
    }),
  ),
)

it.live("restores the acknowledged set after a rejected replacement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let attaches = 0
      const replacement = {
        ...registration,
        name: "search",
        description: "Search for a value",
      }
      const peer = startTransportPeer(({ request, socket }) => {
        if (request.method === "tool.attach" && ++attaches === 2) {
          sendError(socket, request, "replacement rejected")
          return
        }
        sendResult(socket, request, { attached: true })
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => peer.stop()))
      const controller = yield* ToolProducer.make(new Set())
      const firstScope = yield* Scope.make()
      const first = yield* SimulationConnector.backend(peer.url, {
        attach: false,
      }).pipe(Scope.provide(firstScope))
      const firstAttachment = yield* controller.connect(first)
      yield* controller.controls.attach({ tools: [registration] })
      expect(
        yield* controller.controls.attach({ tools: [replacement] }).pipe(Effect.flip),
      ).toMatchObject({ operation: "attach", reason: "rejected" })
      yield* firstAttachment.detach()
      yield* Scope.close(firstScope, Exit.void)
      const secondScope = yield* Scope.make()
      const second = yield* SimulationConnector.backend(peer.url, {
        attach: false,
      }).pipe(Scope.provide(secondScope))
      const secondAttachment = yield* controller.connect(second)

      expect(
        peer.received
          .filter(({ request }) => request.method === "tool.attach")
          .map(({ request }) => request.params),
      ).toEqual([
        { tools: [registration] },
        { tools: [replacement] },
        { tools: [registration] },
      ])
      yield* secondAttachment.detach()
      yield* Scope.close(secondScope, Exit.void)
    }),
  ),
)

it.live("rejects malformed lifecycle acknowledgements without retrying", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = startTransportPeer(({ request, socket }) =>
        sendResult(socket, request, { attached: "invalid" }),
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => peer.stop()))
      const backend = yield* SimulationConnector.backend(peer.url, { attach: false })
      const controller = yield* ToolProducer.make(new Set())
      yield* controller.connect(backend)

      expect(
        yield* controller.controls.attach({ tools: [registration] }).pipe(Effect.flip),
      ).toMatchObject({ operation: "attach", reason: "rejected" })
      expect(peer.received.filter(({ request }) => request.method === "tool.attach")).toHaveLength(1)
    }),
  ),
)

it.live("drains queued invocations before reporting settlement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let attaches = 0
      const peer = startTransportPeer(({ request, socket }) => {
        if (request.method === "tool.attach") {
          attaches++
          if (attaches === 2) notify(socket, "tool.invocation", invocation)
          sendResult(socket, request, { attached: true })
          return
        }
        sendResult(socket, request, { ok: true })
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => peer.stop()))
      const backend = yield* SimulationConnector.backend(peer.url, { attach: false })
      const controller = yield* ToolProducer.make(new Set())
      yield* controller.connect(backend)
      yield* controller.controls.attach({ tools: [registration] })

      expect(yield* controller.settle.pipe(Effect.flip)).toMatchObject({
        operation: "take",
        reason: "rejected",
        message: expect.stringContaining("1 dynamic tool invocation"),
      })
      const call = yield* controller.controls.take("call_lookup")
      yield* call.fail("finished")
      yield* controller.settle
      expect(
        peer.received.filter(({ request }) => request.method === "tool.attach").map(({ request }) => request.params),
      ).toEqual([{ tools: [registration] }, { tools: [] }])
    }),
  ),
)

it.effect("rejects a malformed take call ID", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const controller = yield* ToolProducer.make(new Set())
      expect(
        yield* controller.controls.take(null as unknown as string).pipe(Effect.flip),
      ).toMatchObject({ operation: "take", reason: "rejected" })
    }),
  ),
)

it.live("retries in-flight progress after reconnect without advancing its sequence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let updates = 0
      const firstUpdate = yield* Deferred.make<void>()
      const peer = startTransportPeer(({ request, socket }) => {
        if (request.method === "tool.update" && ++updates === 1) {
          Deferred.doneUnsafe(firstUpdate, Effect.void)
          socket.close()
          return
        }
        sendResult(socket, request, request.method === "tool.attach" ? { attached: true } : { ok: true })
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          // Bun does not resolve server.stop after this peer initiates a WebSocket close.
          void peer.stop()
        }),
      )
      const controller = yield* ToolProducer.make(new Set())
      const firstScope = yield* Scope.make()
      const first = yield* SimulationConnector.backend(peer.url, {
        attach: false,
      }).pipe(Scope.provide(firstScope))
      const firstAttachment = yield* controller.connect(first)
      yield* controller.controls.attach({ tools: [registration] })
      notify(peer.received[0].socket, "tool.invocation", invocation)
      const call = yield* controller.controls.take("call_lookup")

      const progress = yield* call
        .progress({ structured: { phase: "searching" } })
        .pipe(Effect.forkScoped)
      yield* Deferred.await(firstUpdate)
      yield* first.closed
      yield* firstAttachment.detach()
      yield* Scope.close(firstScope, Exit.void)
      const secondScope = yield* Scope.make()
      const second = yield* SimulationConnector.backend(peer.url, {
        attach: false,
      }).pipe(Scope.provide(secondScope))
      const secondAttachment = yield* controller.connect(second)
      yield* Fiber.join(progress)
      yield* call.fail("finished")

      expect(
        peer.received.filter(({ request }) => request.method === "tool.update").map(({ request }) => request.params),
      ).toEqual([
        {
          id: "tool_1",
          sequence: 0,
          update: { structured: { phase: "searching" } },
        },
        {
          id: "tool_1",
          sequence: 0,
          update: { structured: { phase: "searching" } },
        },
      ])
      yield* secondAttachment.detach()
      yield* Scope.close(secondScope, Exit.void)
      yield* controller.endGeneration
      yield* controller.shutdown
    }),
  ),
)

it.live("does not retry progress interrupted by its caller", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const updateReceived = yield* Deferred.make<void>()
      const peer = startTransportPeer(({ request, socket }) => {
        if (request.method === "tool.update") {
          Deferred.doneUnsafe(updateReceived, Effect.void)
          return
        }
        sendResult(socket, request, request.method === "tool.attach" ? { attached: true } : { ok: true })
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => peer.stop()))
      const backend = yield* SimulationConnector.backend(peer.url, { attach: false })
      const controller = yield* ToolProducer.make(new Set())
      yield* controller.connect(backend)
      yield* controller.controls.attach({ tools: [registration] })
      notify(peer.received[0].socket, "tool.invocation", invocation)
      const call = yield* controller.controls.take("call_lookup")

      const progress = yield* call
        .progress({ structured: { phase: "searching" } })
        .pipe(Effect.forkScoped)
      yield* Deferred.await(updateReceived)
      yield* Fiber.interrupt(progress)
      yield* call.fail("finished")

      expect(peer.received.filter(({ request }) => request.method === "tool.update")).toHaveLength(1)
    }),
  ),
)

it.live("rejects malformed progress without advancing its sequence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = startTransportPeer(({ request, socket }) =>
        sendResult(socket, request, request.method === "tool.attach" ? { attached: true } : { ok: true }),
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => peer.stop()))
      const backend = yield* SimulationConnector.backend(peer.url, { attach: false })
      const controller = yield* ToolProducer.make(new Set())
      yield* controller.connect(backend)
      yield* controller.controls.attach({ tools: [registration] })
      notify(peer.received[0].socket, "tool.invocation", invocation)
      const call = yield* controller.controls.take("call_lookup")

      const malformed = { structured: [] } as unknown as Progress
      expect(yield* call.progress(malformed).pipe(Effect.flip)).toMatchObject({
        operation: "progress",
        reason: "rejected",
        callID: "call_lookup",
      })
      yield* call.progress({ structured: { phase: "valid" } })
      yield* call.fail("finished")

      expect(
        peer.received.filter(({ request }) => request.method === "tool.update").map(({ request }) => request.params),
      ).toEqual([
        {
          id: "tool_1",
          sequence: 0,
          update: { structured: { phase: "valid" } },
        },
      ])
    }),
  ),
)

it.live("rejects dynamic names that collide with static adapters", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = startTransportPeer(({ request, socket }) => sendResult(socket, request, { attached: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => peer.stop()))
      const backend = yield* SimulationConnector.backend(peer.url, {
        attach: false,
      })
      const controller = yield* ToolProducer.make(new Set(["shell"]))
      yield* controller.connect(backend)

      expect(
        yield* controller.controls
          .attach({
            tools: [{ ...registration, name: "shell" }],
          })
          .pipe(Effect.flip),
      ).toMatchObject({
        operation: "attach",
        reason: "rejected",
        message: expect.stringContaining("static adapter: shell"),
      })
      expect(peer.received).toEqual([])
    }),
  ),
)
