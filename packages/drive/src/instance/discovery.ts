import { readdir } from "node:fs/promises"
import { join } from "node:path"

// Reads the OpenCode managed-service registration from an instance's private
// XDG state directory. The chaos proxy resolves its upstream through this,
// and TUIs pinned to the proxy authenticate with the registered password.

export interface Registration {
  readonly url: string
  readonly password?: string
}

export async function discoverRegistration(
  state: string,
): Promise<Registration | undefined> {
  const directory = join(state, "opencode")
  const discovered = await readdir(directory).catch(
    () => [] as ReadonlyArray<string>,
  )
  const names = [
    "service-local.json",
    "service.json",
    ...discovered
      .filter((name) => /^service-[^.]+\.json$/.test(name))
      .sort()
      .filter((name) => name !== "service-local.json"),
  ]
  for (const name of names) {
    const value: unknown = await Bun.file(join(directory, name))
      .json()
      .catch(() => undefined)
    if (
      typeof value === "object" &&
      value !== null &&
      "url" in value &&
      typeof value.url === "string"
    )
      return {
        url: value.url,
        ...("password" in value && typeof value.password === "string"
          ? { password: value.password }
          : {}),
      }
  }
  return undefined
}
