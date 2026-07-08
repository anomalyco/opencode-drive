import { request } from "./control.js"
import { manifestPath, resolveInstance } from "./registry.js"

export async function stop(name?: string) {
  const manifest = await resolveInstance(name)
  await request(manifest.control, "stop")
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const current: unknown = await Bun.file(manifestPath(manifest.name))
      .json()
      .catch(() => undefined)
    if (
      typeof current !== "object" ||
      current === null ||
      !("pid" in current) ||
      current.pid !== manifest.pid
    ) {
      console.log("success")
      return
    }
    await Bun.sleep(25)
  }
  throw new Error(`timed out stopping drive instance "${manifest.name}"`)
}
