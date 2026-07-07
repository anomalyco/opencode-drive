import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { connectDrive } from "../experimental/drive.js"
import type { Driver } from "../experimental/drive.js"

const driver = process.argv[2]
if (!driver) throw new Error("driver file is required")
const name = requiredArgument(3, "instance name")
const ui = requiredArgument(4, "frontend WebSocket URL")
const backend = requiredArgument(5, "backend WebSocket URL")
const artifacts = requiredArgument(6, "artifacts directory")

const module: { readonly default?: unknown } = await import(pathToFileURL(resolve(driver)).href)
if (!isDriver(module.default)) throw new Error("driver must default-export defineDriver(...)")
const controller = new AbortController()
process.once("SIGINT", () => controller.abort())
process.once("SIGTERM", () => controller.abort())
const session = await connectDrive({ ui, backend })
try {
  await module.default({
    name,
    ui: session.ui,
    backend: session.backend,
    artifacts,
    signal: controller.signal,
  })
} finally {
  session.close()
}

function isDriver(value: unknown): value is Driver {
  return typeof value === "function"
}

function requiredArgument(index: number, name: string) {
  const value = process.argv[index]
  if (!value) throw new Error(`${name} is required`)
  return value
}
