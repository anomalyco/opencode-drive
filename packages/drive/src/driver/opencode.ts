import { join } from "node:path"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import {
  OpenCode as OpenCodeService,
  type OpenCodeClient,
} from "@opencode/client/effect"
import * as Service from "@opencode/client/effect/service"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/http"
import { projectDirectory } from "../instance/instance.js"
import { error, type OpenCodeDriverError } from "./error.js"

export type OpenCode = OpenCodeClient

/** The URL and credential of a running OpenCode service. */
export type ServiceEndpoint = Service.Endpoint

const discoverWithServices = Effect.fn("OpenCode.discover")(function* (
  artifacts: string,
) {
  const state = join(artifacts, "home", ".local", "state", "opencode")
  const fs = yield* FileSystem.FileSystem
  const discovered = yield* fs.readDirectory(state).pipe(
    Effect.catch(() => Effect.succeed([])),
  )
  const names = [
    "service-local.json",
    "service.json",
    ...discovered
      .filter((name) => /^service-[^.]+\.json$/.test(name))
      .sort()
      .filter((name) => name !== "service-local.json"),
  ]
  let endpoint: Service.Endpoint | undefined
  for (const name of names) {
    endpoint = yield* Service.discover({ file: join(state, name) })
    if (endpoint !== undefined) break
  }
  if (endpoint === undefined)
    return yield* Effect.fail(
      error("opencode.connect", "OpenCode service registration was not found"),
    )
  return endpoint
})

const makeWithServices = Effect.fn("OpenCode.make")(function* (
  artifacts: string,
  directory: string,
) {
  const endpoint = yield* discoverWithServices(artifacts)
  return yield* Effect.gen(function* () {
    const base = yield* HttpClient.HttpClient
    const located = base.pipe(
      HttpClient.mapRequest(
        HttpClientRequest.setHeader(
          "x-opencode-directory",
          encodeURIComponent(directory),
        ),
      ),
    )
    const http = endpoint.auth === undefined
      ? located
      : located.pipe(
          HttpClient.mapRequest(
            HttpClientRequest.basicAuth(
              endpoint.auth.username,
              endpoint.auth.password,
            ),
          ),
        )
    return yield* OpenCodeService.make({ baseUrl: endpoint.url }).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    )
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError((cause) => error("opencode.connect", cause)),
  )
})

/** Discovers the registered endpoint of an instance's isolated OpenCode service. */
export const discover = (
  artifacts: string,
): Effect.Effect<ServiceEndpoint, OpenCodeDriverError> =>
  discoverWithServices(artifacts).pipe(Effect.provide(NodeFileSystem.layer))

export const make = (
  artifacts: string,
  directory = projectDirectory(artifacts),
): Effect.Effect<OpenCode, OpenCodeDriverError> =>
  makeWithServices(artifacts, directory).pipe(Effect.provide(NodeFileSystem.layer))
