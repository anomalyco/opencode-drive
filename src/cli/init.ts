import { initializeInstance } from "./instance.js"
import { initializeManifest } from "./registry.js"

export async function init(name: string) {
  const manifest = await initializeManifest(name, process.cwd(), initializeInstance)
  console.log(manifest.artifacts)
}
