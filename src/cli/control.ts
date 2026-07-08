import { rm } from "node:fs/promises"
import { connect, createServer } from "node:net"
import type {
  ResponseConfiguration,
  ResponseUpdate,
} from "./response-generator.js"

export async function listenControl(
  path: string,
  handlers: {
    readonly restart: () => Promise<void>
    readonly stop: () => Promise<void>
    readonly responses: (
      input: ResponseUpdate,
    ) => Promise<ResponseConfiguration>
  },
) {
  const server = createServer((socket) => {
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("data", (data) => {
      buffer += data
      if (buffer.length > 64 * 1024) {
        socket.removeAllListeners("data")
        socket.end("error: control request exceeds 64 KiB\n")
        return
      }
      if (!buffer.includes("\n")) return
      socket.removeAllListeners("data")
      void handle(buffer.slice(0, buffer.indexOf("\n"))).then(
        (result) =>
          socket.end(
            `success${result === undefined ? "" : ` ${JSON.stringify(result)}`}\n`,
          ),
        (error) =>
          socket.end(
            `error: ${error instanceof Error ? error.message : String(error)}\n`,
          ),
      )
    })
  })
  const handle = async (input: string) => {
    if (input === "restart") return handlers.restart()
    if (input === "stop") return handlers.stop()
    if (input === "responses") return handlers.responses({})
    if (input.startsWith("responses "))
      return handlers.responses(parseResponseUpdate(input.slice("responses ".length)))
    throw new Error("unknown control command")
  }
  await listen(server, path)
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(path, { force: true })
  }
}

export async function request(path: string, command: "restart" | "stop") {
  const response = await send(path, command)
  if (response !== "success") throw responseError(response)
}

export async function requestResponses(path: string, input: ResponseUpdate) {
  const response = await send(
    path,
    Object.keys(input).length === 0
      ? "responses"
      : `responses ${JSON.stringify(input)}`,
  )
  if (!response.startsWith("success ")) throw responseError(response)
  const value: unknown = JSON.parse(response.slice("success ".length))
  if (!isResponseConfiguration(value))
    throw new Error("instance returned an invalid response configuration")
  return value
}

function send(path: string, command: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(path)
    let response = ""
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("instance control request timed out"))
    }, 10_000)
    socket.setEncoding("utf8")
    socket.on("connect", () => socket.write(`${command}\n`))
    socket.on("data", (data) => {
      response += data
    })
    socket.on("end", () => {
      clearTimeout(timer)
      resolve(response.trim())
    })
    socket.on("error", () => {
      clearTimeout(timer)
      reject(new Error("instance control socket is unavailable"))
    })
  })
}

function parseResponseUpdate(input: string): ResponseUpdate {
  const value: unknown = JSON.parse(input)
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid responses configuration")
  const types = "types" in value ? stringArray(value.types) : undefined
  const tools = "tools" in value ? stringArray(value.tools) : undefined
  return {
    ...(types === undefined ? {} : { types }),
    ...(tools === undefined ? {} : { tools }),
  }
}

function stringArray(value: unknown) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error("response types and tools must be string arrays")
  return value
}

function isResponseConfiguration(
  value: unknown,
): value is ResponseConfiguration {
  if (typeof value !== "object" || value === null) return false
  if (!("types" in value) || !stringArrayValue(value.types)) return false
  return "tools" in value && stringArrayValue(value.tools)
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function responseError(response: string) {
  return new Error(response.replace(/^error:\s*/, "") || "empty control response")
}

async function listen(server: ReturnType<typeof createServer>, path: string) {
  await rm(path, { force: true })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, () => {
      server.off("error", reject)
      resolve()
    })
  })
}
