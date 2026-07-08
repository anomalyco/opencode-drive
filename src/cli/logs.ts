import { join } from "node:path"
import { resolveInstance } from "./registry.js"

export async function logs(name?: string) {
  const manifest = await resolveInstance(name)
  console.log(
    join(manifest.artifacts, "logs", "opencode", "log", "opencode*.log"),
  )
}
