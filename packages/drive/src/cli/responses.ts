import { requestResponses } from "../instance/control.js"
import { resolveInstance } from "../instance/registry.js"

export async function responses(options: {
  readonly name?: string
  readonly types?: string
  readonly tools?: string
}) {
  const manifest = await resolveInstance(options.name)
  const configuration = await requestResponses(manifest.control, {
    ...(options.types === undefined ? {} : { types: split(options.types) }),
    ...(options.tools === undefined ? {} : { tools: split(options.tools) }),
  })
  console.log(`Types: ${configuration.types.join(",")}`)
  console.log(`Tools: ${configuration.tools.join(",")}`)
}

function split(value: string) {
  return value.split(",").map((item) => item.trim())
}
