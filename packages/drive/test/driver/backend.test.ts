import { readFile, rm, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { OpenCodeBackend } from "../../src/index.js"
import { discoverRegistration } from "../../src/instance/discovery.js"
import type { Endpoint } from "../../src/index.js"

const fakeOpenCode = [
  process.execPath,
  resolve("test", "fixtures", "fake-opencode.ts"),
]

it.live("exposes the service endpoint across server restarts", () =>
  OpenCodeBackend.use(
    { opencode: { command: fakeOpenCode } },
    ({ opencode, server }) =>
      Effect.gen(function* () {
        expect(yield* opencode.server.info()).toMatchObject({ version: "test" })
        const first = yield* server.endpoint()
        expect(first.auth).toMatchObject({ type: "basic", password: "drive-test-password" })
        expect(yield* info(first)).toBe(200)
        expect(yield* info({ ...first, auth: undefined })).toBe(401)

        yield* server.kill()
        expect(yield* server.endpoint().pipe(Effect.flip)).toMatchObject({
          operation: "server.endpoint",
        })
        yield* server.launch()
        const second = yield* server.endpoint()
        expect(second).toEqual(first)
        expect(yield* info(second)).toBe(200)
      }),
  ),
)

it.live("settles a backend program and reports only the backend endpoint", () =>
  Effect.gen(function* () {
    const result = yield* OpenCodeBackend.useReport(
      {
        keepArtifacts: true,
        opencode: { command: fakeOpenCode },
      },
      ({ artifacts }) => Effect.succeed(artifacts),
    )
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(result.value, { recursive: true, force: true })),
    )

    expect(result.report).toMatchObject({
      artifacts: result.value,
      retained: true,
      recordings: [],
      compatibility: [
        { _tag: "Negotiated", role: "backend", protocolVersion: 1 },
      ],
    })
    expect(
      yield* Effect.promise(() =>
        stat(`${result.value}/child.pid`).then(() => true, () => false),
      ),
    ).toBe(false)
    const service = Number(
      yield* Effect.promise(() => readFile(`${result.value}/service.pid`, "utf8")),
    )
    expect(isRunning(service)).toBe(false)
  }),
)

it.live("routes the endpoint through the chaos network proxy", () =>
  OpenCodeBackend.use(
    {
      network: true,
      opencode: { command: fakeOpenCode },
    },
    ({ server, network, environment }) =>
      Effect.gen(function* () {
        const endpoint = yield* server.endpoint()
        const registration = yield* Effect.promise(() =>
          discoverRegistration(environment.XDG_STATE_HOME!),
        )
        expect(endpoint.url).not.toBe(registration?.url)
        expect(yield* info(endpoint)).toBe(200)
        expect(yield* network.connections()).toBeGreaterThan(0)

        yield* network.killConnections()
        yield* network.set({ refuseNew: true })
        expect(yield* info(endpoint).pipe(Effect.flip)).toBeDefined()
        yield* network.clear()
        expect(yield* info(endpoint)).toBe(200)
      }),
  ),
)

const info = (endpoint: Endpoint) =>
  Effect.tryPromise(() =>
    fetch(`${endpoint.url}/api/info`, {
      headers: endpoint.auth === undefined
        ? {}
        : {
            authorization: `Basic ${btoa(`${endpoint.auth.username}:${endpoint.auth.password}`)}`,
          },
    }).then((response) => response.status),
  )

function isRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
