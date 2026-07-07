import { join } from "node:path"
import { resolveInstance } from "./registry.js"

export async function describe(name?: string) {
  const manifest = await resolveInstance(name ?? "default")
  console.log([
    `PID: ${manifest.pid}`,
    `Headless: ${manifest.headless}`,
    `Artifacts: ${manifest.artifacts}`,
    `UI: ${manifest.endpoints.ui}`,
    `Backend: ${manifest.endpoints.backend}`,
    `Logs: ${join(manifest.artifacts, "home", ".local", "share", "opencode", "log", "opencode*.log")}`,
  ].join("\n"))
}
