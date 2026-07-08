import { listInstances, manifestPath } from "./registry.js"

export async function list() {
  const instances = await listInstances()
  console.log(
    instances
      .map((instance) => `${instance.name}: ${manifestPath(instance.name)}`)
      .join("\n"),
  )
}
