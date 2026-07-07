import type { BackendFinishReason, BackendItem, KeyModifiers } from "../client/index.js"
import { connectBackendSimulation, connectSimulation } from "../client/index.js"
import type { DriveCommand, InstanceManifest } from "./types.js"

const noValue = new Set([
  "render",
  "state",
  "start-record",
  "end-record",
  "enter",
  "llm.pending",
  "network.log",
])

const withValue = new Set([
  "type",
  "press",
  "arrow",
  "focus",
  "click",
  "llm.respond",
  "llm.chunk",
  "llm.finish",
  "llm.disconnect",
])

export function commandAcceptsValue(operation: string) {
  if (noValue.has(operation)) return false
  if (withValue.has(operation)) return true
  throw new Error(`unknown drive command "${operation}"`)
}

export function commandNames() {
  return [...noValue, ...withValue].sort()
}

export async function executeCommands(manifest: InstanceManifest, commands: ReadonlyArray<DriveCommand>) {
  const clients: {
    ui?: Awaited<ReturnType<typeof connectSimulation>>
    backend?: Awaited<ReturnType<typeof connectBackendSimulation>>
  } = {}
  const ui = async () => (clients.ui ??= await connectSimulation({ url: manifest.endpoints.ui }))
  const backend = async () => (clients.backend ??= await connectBackendSimulation({ url: manifest.endpoints.backend }))
  const results: Array<{ readonly command: string; readonly result: unknown }> = []
  try {
    for (const command of commands) {
      results.push({ command: command.operation, result: await execute(command, ui, backend) })
    }
    return { name: manifest.name, results }
  } catch (error) {
    throw new CommandBatchError(manifest.name, results, error)
  } finally {
    clients.ui?.close()
    clients.backend?.close()
  }
}

export class CommandBatchError extends Error {
  constructor(
    readonly instance: string,
    readonly results: ReadonlyArray<{ readonly command: string; readonly result: unknown }>,
    readonly reason: unknown,
  ) {
    super(reason instanceof Error ? reason.message : String(reason))
    this.name = "CommandBatchError"
  }
}

async function execute(
  command: DriveCommand,
  ui: () => Promise<Awaited<ReturnType<typeof connectSimulation>>>,
  backend: () => Promise<Awaited<ReturnType<typeof connectBackendSimulation>>>,
) {
  switch (command.operation) {
    case "render": return (await ui()).render()
    case "state": return (await ui()).state()
    case "start-record": return (await ui()).startRecord()
    case "end-record": return (await ui()).endRecord()
    case "type": return (await ui()).typeText(required(command))
    case "press": {
      const value = required(command)
      if (!value.trim().startsWith("{")) return value === "enter" ? (await ui()).pressEnter() : (await ui()).pressKey(value)
      const input = object(value)
      return (await ui()).pressKey(string(input, "key"), modifiers(input.modifiers))
    }
    case "enter": return (await ui()).pressEnter()
    case "arrow": {
      const direction = required(command)
      if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") {
        throw new Error("arrow must be up, down, left, or right")
      }
      return (await ui()).pressArrow(direction)
    }
    case "focus": return (await ui()).focus(number(required(command), "target"))
    case "click": {
      const input = object(required(command))
      return (await ui()).click(number(input.target, "target"), number(input.x, "x"), number(input.y, "y"))
    }
    case "llm.pending": return (await backend()).pendingExchanges()
    case "llm.respond": {
      const input = object(required(command))
      const client = await backend()
      const chunk = await client.chunk(string(input, "id"), [{ type: "textDelta", text: string(input, "text") }])
      const finish = await client.finish(string(input, "id"), finishReason(input.reason))
      return { chunk, finish }
    }
    case "llm.chunk": {
      const input = object(required(command))
      if (!Array.isArray(input.items)) throw new Error("llm.chunk items must be an array")
      return (await backend()).chunk(string(input, "id"), input.items as ReadonlyArray<BackendItem>)
    }
    case "llm.finish": {
      const input = scalarOrObject(required(command), "id")
      return (await backend()).finish(string(input, "id"), finishReason(input.reason))
    }
    case "llm.disconnect": return (await backend()).disconnect(required(command))
    case "network.log": return (await backend()).networkLog()
  }
  throw new Error(`unknown drive command "${command.operation}"`)
}

function required(command: DriveCommand) {
  if (command.value === undefined) throw new Error(`${command.operation} requires a value`)
  return command.value
}

function object(value: string) {
  const parsed: unknown = JSON.parse(value)
  if (!isRecord(parsed)) throw new Error("command value must be a JSON object")
  return parsed
}

function scalarOrObject(value: string, key: string) {
  return value.trim().startsWith("{") ? object(value) : { [key]: value }
}

function string(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

function number(value: unknown, name: string) {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`)
  return parsed
}

function modifiers(value: unknown): KeyModifiers | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error("modifiers must be an object")
  return {
    ctrl: optionalBoolean(value.ctrl, "ctrl"),
    shift: optionalBoolean(value.shift, "shift"),
    meta: optionalBoolean(value.meta, "meta"),
    super: optionalBoolean(value.super, "super"),
    hyper: optionalBoolean(value.hyper, "hyper"),
  }
}

function finishReason(value: unknown): BackendFinishReason | undefined {
  if (value === undefined) return undefined
  if (value === "stop" || value === "tool-calls" || value === "length" || value === "content-filter") return value
  throw new Error("reason must be stop, tool-calls, length, or content-filter")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalBoolean(value: unknown, name: string) {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`)
  return value
}
