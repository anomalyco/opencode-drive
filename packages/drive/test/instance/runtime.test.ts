import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Fiber, Schema } from "effect"
import { initializeInstance } from "../../src/instance/instance.js"
import { OpenCodeInstance } from "../../src/instance/runtime.js"
import { make } from "../../src/driver/opencode.js"
import { discoverRegistration } from "../../src/instance/discovery.js"

const fakeOpenCode = [
  process.execPath,
  resolve("test", "fixtures", "fake-opencode.ts"),
]
const decodeConnection = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
  argv: Schema.Array(Schema.String),
  authenticated: Schema.Boolean,
})))

it.live("pins scripted TUIs and existing SDKs to the owned server across replacement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const artifacts = yield* Effect.promise(() => initializeInstance())
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(artifacts, { recursive: true, force: true })))
      const instance = yield* OpenCodeInstance.make({
        artifacts,
        name: "owned-server-test",
        scripted: true,
        command: fakeOpenCode,
      })
      yield* instance.launchServer
      const sdk = yield* make(artifacts)
      const before = yield* sdk.health.get()
      const registration = yield* Effect.promise(() => discoverRegistration(`${artifacts}/home/.local/state`))
      yield* instance.launchTui("retained")
      const connection = yield* Effect.promise(() => Bun.file(`${artifacts}/client-connection.json`).text()).pipe(
        Effect.flatMap(decodeConnection),
      )
      expect(connection.argv.slice(-2)).toEqual(["--server", registration?.url])
      expect(connection.authenticated).toBe(true)
      yield* instance.killServer
      yield* instance.launchServer
      const after = yield* sdk.health.get()
      expect(after.healthy).toBe(true)
      expect(after.pid).not.toBe(before.pid)
      const replacement = yield* Effect.promise(() => discoverRegistration(`${artifacts}/home/.local/state`))
      expect(replacement?.url).toBe(registration?.url)
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
)

it.live("preserves owned-port boot failures and permits launch after the overlap ends", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const artifacts = yield* Effect.promise(() => initializeInstance())
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(artifacts, { recursive: true, force: true })))
      const instance = yield* OpenCodeInstance.make({
        artifacts,
        name: "occupied-server-test",
        scripted: true,
        command: fakeOpenCode,
      })
      yield* instance.launchServer
      const sdk = yield* make(artifacts)
      const registration = yield* Effect.promise(() => discoverRegistration(`${artifacts}/home/.local/state`))
      if (registration === undefined) return yield* Effect.dieMessage("service registration missing")
      yield* instance.killServer
      const blocker = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: Number(new URL(registration.url).port),
            fetch: () => new Response("occupied"),
          }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      const failed = yield* instance.launchServer.pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      yield* Effect.promise(() => blocker.stop(true))
      yield* instance.launchServer
      expect((yield* sdk.health.get()).healthy).toBe(true)
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
)

it.live("stops a TUI while its readiness check is pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const artifacts = yield* Effect.promise(() => initializeInstance())
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(artifacts, { recursive: true, force: true })))
      const instance = yield* OpenCodeInstance.make({
        artifacts,
        name: "pending-client-test",
        scripted: true,
        command: [...fakeOpenCode, "no-ui"],
      })

      yield* instance.launchServer
      const launch = yield* instance.launchTui("pending").pipe(Effect.exit, Effect.forkChild)
      yield* Effect.sleep(100)

      const started = Date.now()
      yield* instance.stop
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(Exit.isFailure(yield* Fiber.join(launch))).toBe(true)
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
)

it.live("keeps chaos TUIs on the proxy and non-scripted launches managed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const artifacts = yield* Effect.promise(() => initializeInstance())
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(artifacts, { recursive: true, force: true })))
      const instance = yield* OpenCodeInstance.make({
        artifacts,
        name: "proxy-server-test",
        scripted: true,
        command: fakeOpenCode,
        network: true,
      })
      yield* instance.launchServer
      yield* instance.launchTui("proxy")
      const connection = yield* Effect.promise(() => Bun.file(`${artifacts}/client-connection.json`).text()).pipe(
        Effect.flatMap(decodeConnection),
      )
      expect(connection.argv.slice(-2)).toEqual(["--server", instance.network?.url])
      expect(connection.authenticated).toBe(true)
      yield* instance.stop

      const managedArtifacts = yield* Effect.promise(() => initializeInstance())
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(managedArtifacts, { recursive: true, force: true })))
      const managed = yield* OpenCodeInstance.make({
        artifacts: managedArtifacts,
        name: "managed-server-test",
        command: fakeOpenCode,
      })
      yield* managed.waitForDrive()
      const managedConnection = yield* Effect.promise(() =>
        Bun.file(`${managedArtifacts}/client-connection.json`).text(),
      ).pipe(Effect.flatMap(decodeConnection))
      expect(managedConnection.argv).not.toContain("--server")
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
)

it.live("reads the database target from Effect config", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const artifacts = yield* Effect.promise(() => initializeInstance())
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(artifacts, { recursive: true, force: true })))
      const instance = yield* OpenCodeInstance.make({
        artifacts,
        name: "database-config-test",
        scripted: true,
        command: fakeOpenCode,
      })
      yield* Effect.addFinalizer(() => instance.stop)

      yield* instance.launchServer
      expect(yield* Effect.promise(() => Bun.file(`${artifacts}/service-db.txt`).text())).toBe("restart.sqlite")
    }),
  ).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_DRIVE_DB: "restart.sqlite" }))),
    Effect.provide(NodeServices.layer),
  ),
)
