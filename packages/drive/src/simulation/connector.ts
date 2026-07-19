import * as Context from "effect/Context"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { RpcClient, RpcClientError } from "effect/unstable/rpc"
import packageJson from "../../package.json" with { type: "json" }
import * as OpenCodeRpcProtocol from "./opencode-protocol.js"
import {
  Backend as BackendProtocol,
  Frontend as FrontendProtocol,
  Handshake,
} from "./protocol.js"
import { BackendRpcs, SimulationRequestError, UiRpcs } from "./rpc.js"

export class SimulationConnectionError extends Schema.TaggedErrorClass<SimulationConnectionError>()(
  "SimulationConnectionError",
  {
    endpoint: Schema.String,
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class SimulationCompatibilityError extends Schema.TaggedErrorClass<SimulationCompatibilityError>()(
  "SimulationCompatibilityError",
  {
    endpoint: Schema.String,
    role: Handshake.EndpointRole,
    message: Schema.String,
  },
) {}

export const EndpointCompatibility = Schema.TaggedUnion({
  Negotiated: {
    endpoint: Schema.String,
    role: Handshake.EndpointRole,
    protocolVersion: Handshake.ProtocolVersion,
    server: Handshake.Identity,
    capabilities: Schema.Array(Handshake.Capability),
  },
  Legacy: {
    endpoint: Schema.String,
    role: Handshake.EndpointRole,
    profile: Schema.Literal("opencode-simulation-jsonrpc-v0"),
    reason: Schema.String,
  },
})
export type EndpointCompatibility = typeof EndpointCompatibility.Type

export function supportsCapability(
  compatibility: EndpointCompatibility,
  capability: Handshake.Capability,
) {
  return compatibility._tag === "Negotiated" &&
    compatibility.capabilities.includes(capability)
}

export type CompatibilityPolicy = "required" | "preferred"

export interface Options {
  readonly connectTimeout?: number
  readonly requestTimeout?: number
  readonly attach?: boolean
  readonly compatibility?: CompatibilityPolicy
}

export type UiClient = RpcClient.FromGroup<
  typeof UiRpcs,
  RpcClientError.RpcClientError
>
export type BackendClient = RpcClient.FromGroup<
  typeof BackendRpcs,
  RpcClientError.RpcClientError
>

export interface UiConnection {
  readonly endpoint: string
  readonly rpc: UiClient
  readonly compatibility: EndpointCompatibility
}

export interface BackendConnection {
  readonly endpoint: string
  readonly rpc: BackendClient
  readonly compatibility: EndpointCompatibility
  readonly requests: Stream.Stream<
    BackendProtocol.OpenedExchange,
    Schema.SchemaError
  >
  readonly closed: Effect.Effect<void>
  readonly attach: () => Effect.Effect<
    { readonly attached: true },
    | SimulationConnectionError
    | RpcClientError.RpcClientError
    | SimulationRequestError
  >
}

export const ui = Effect.fn("SimulationConnector.ui")(function* (
  endpoint: string,
  options?: Options,
) {
  const protocol = yield* OpenCodeRpcProtocol.make(endpoint, {
    connectTimeout: options?.connectTimeout,
    firstWireId: 0,
  })
  const rpc = yield* RpcClient.make(UiRpcs).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  )
  const required = FrontendProtocol.Capabilities.filter(
    (capability) =>
      capability !== "ui.snapshot" && capability !== "ui.click.semantic",
  )
  const compatibility = yield* negotiate(
    endpoint,
    "ui",
    required,
    rpc["simulation.handshake"]({
      client: { name: "opencode-drive", version: packageJson.version },
      expectedRole: "ui",
      offeredVersions: [1],
      requiredCapabilities: required,
      optionalCapabilities: ["ui.snapshot", "ui.click.semantic"],
    }),
    options?.compatibility,
  )
  return { endpoint, rpc, compatibility } satisfies UiConnection
})

export const backend = Effect.fn("SimulationConnector.backend")(function* (
  endpoint: string,
  options?: Options,
) {
  const requests = yield* Queue.unbounded<
    BackendProtocol.OpenedExchange,
    Schema.SchemaError
  >()
  const closed = yield* Deferred.make<void>()
  const close = Effect.all([
    Deferred.succeed(closed, undefined),
    Queue.shutdown(requests),
  ], { discard: true })
  yield* Effect.addFinalizer(() => close)
  const protocol = yield* OpenCodeRpcProtocol.make(endpoint, {
    connectTimeout: options?.connectTimeout,
    firstWireId: 0,
    onClose: () => close,
    onNotification: ({ method, params }) => {
      if (method !== "llm.request") return Effect.void
      return Effect.matchEffect(
        Schema.decodeUnknownEffect(BackendProtocol.OpenedExchange)(params),
        {
          onFailure: (error) => Queue.fail(requests, error).pipe(Effect.asVoid),
          onSuccess: (request) =>
            Queue.offer(requests, request).pipe(Effect.asVoid),
        },
      )
    },
  })
  const rpc = yield* RpcClient.make(BackendRpcs).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  )
  const required = BackendProtocol.Capabilities.filter(
    (capability) => capability !== "llm.pending",
  )
  const compatibility = yield* negotiate(
    endpoint,
    "backend",
    required,
    rpc["simulation.handshake"]({
      client: { name: "opencode-drive", version: packageJson.version },
      expectedRole: "backend",
      offeredVersions: [1],
      requiredCapabilities: required,
      optionalCapabilities: ["llm.pending"],
    }),
    options?.compatibility,
  )
  const attach = Effect.fn("SimulationConnector.attach")(() =>
    rpc["llm.attach"]().pipe(
      Effect.timeoutOrElse({
        duration: options?.requestTimeout ?? 30_000,
        orElse: () =>
          Effect.fail(
            new SimulationConnectionError({
              endpoint,
              operation: "llm.attach",
              message: `llm.attach timed out after ${options?.requestTimeout ?? 30_000}ms`,
            }),
          ),
      }),
    ),
  )
  if (options?.attach !== false) yield* attach()
  return {
    endpoint,
    rpc,
    compatibility,
    requests: Stream.fromQueue(requests),
    closed: Deferred.await(closed),
    attach,
  } satisfies BackendConnection
})

export interface Interface {
  readonly ui: typeof ui
  readonly backend: typeof backend
}

export class Service extends Context.Service<Service, Interface>()(
  "opencode-drive/SimulationConnector",
) {}

export const layer = Layer.succeed(Service, Service.of({ ui, backend }))

const negotiate = Effect.fn("SimulationConnector.negotiate")(function* (
  endpoint: string,
  role: Handshake.EndpointRole,
  required: ReadonlyArray<Handshake.Capability>,
  handshake: Effect.Effect<Handshake.Response, unknown>,
  policy: CompatibilityPolicy = "preferred",
) {
  const legacy = (reason: string): EndpointCompatibility =>
    EndpointCompatibility.cases.Legacy.make({
      endpoint,
      role,
      profile: "opencode-simulation-jsonrpc-v0",
      reason,
    })
  const result = yield* Effect.exit(handshake)
  if (result._tag === "Success") {
    const missing = required.filter(
      (capability) => !result.value.capabilities.includes(capability),
    )
    if (result.value.role !== role || missing.length > 0)
      return yield* Effect.fail(
        new SimulationCompatibilityError({
          endpoint,
          role,
          message: result.value.role !== role
            ? `Expected ${role} simulation endpoint, received ${result.value.role}`
            : `Simulation endpoint is missing required capabilities: ${missing.join(", ")}`,
        }),
      )
    return EndpointCompatibility.cases.Negotiated.make({
      endpoint,
      role: result.value.role,
      protocolVersion: result.value.protocolVersion,
      server: result.value.server,
      capabilities: result.value.capabilities,
    })
  }
  const cause = result.cause
  const message = Cause.pretty(cause)
  if (policy === "preferred" && isHandshakeUnavailable(cause))
    return legacy(message)
  return yield* Effect.fail(
    new SimulationCompatibilityError({ endpoint, role, message }),
  )
})

function isHandshakeUnavailable(cause: Cause.Cause<unknown>) {
  const failure = Cause.findErrorOption(cause)
  return Option.isSome(failure) &&
    failure.value instanceof SimulationRequestError &&
    failure.value.code === -32601
}

export * as SimulationConnector from "./connector.js"
