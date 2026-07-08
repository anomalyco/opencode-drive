import { requestStop } from "./control.js"
import { manifestPath, resolveInstance } from "./registry.js"

export async function stop(name?: string) {
  const manifest = await resolveInstance(name)
  const result = await requestStop(manifest.control, (percent) => {
    console.error(`Rendering video: ${percent}%`)
  })
  const deadline = Date.now() + 5 * 60_000
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
      for (const screenshot of result.screenshots) console.log(screenshot)
      if (result.recording) {
        console.error(`Video successfully created: ${result.recording}`)
      } else if (result.screenshots.length === 0) {
        console.log("success")
      }
      return
    }
    await Bun.sleep(25)
  }
  throw new Error(`timed out stopping drive instance "${manifest.name}"`)
}
