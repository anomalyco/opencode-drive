import * as Effect from "effect/Effect"
import type * as Proxy from "../instance/proxy.js"
import { error, type OpenCodeDriverError } from "./error.js"

// Script-facing control over the chaos network proxy between launched TUIs
// and the OpenCode server. Available when the driver's network option is
// enabled; every operation fails otherwise.

export type NetworkConditions = Proxy.Conditions

export interface Network {
  /** Replaces the network conditions. Omitted fields reset to no-op defaults. */
  readonly set: (
    conditions: NetworkConditions,
  ) => Effect.Effect<void, OpenCodeDriverError>
  /** Restores unimpaired networking. Bytes buffered by a blackhole flush. */
  readonly clear: () => Effect.Effect<void, OpenCodeDriverError>
  /** Abruptly terminates every proxied connection. Returns how many were killed. */
  readonly killConnections: () => Effect.Effect<number, OpenCodeDriverError>
  /** The number of live proxied connections. */
  readonly connections: () => Effect.Effect<number, OpenCodeDriverError>
}

export const make = (proxy: Proxy.ChaosProxy | undefined): Network => {
  const withProxy = <A>(
    operation: string,
    f: (proxy: Proxy.ChaosProxy) => A,
  ): Effect.Effect<A, OpenCodeDriverError> =>
    proxy === undefined
      ? Effect.fail(
          error(
            operation,
            "network chaos requires the driver's network option",
          ),
        )
      : Effect.sync(() => f(proxy))
  return {
    set: (conditions) => withProxy("network.set", (p) => p.set(conditions)),
    clear: () => withProxy("network.clear", (p) => p.set({})),
    killConnections: () =>
      withProxy("network.kill", (p) => p.killConnections()),
    connections: () => withProxy("network.connections", (p) => p.connections()),
  }
}

export * as OpenCodeNetwork from "./network.js"
