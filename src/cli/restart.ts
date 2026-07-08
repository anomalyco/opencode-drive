import { request } from "./control.js"
import { resolveInstance } from "./registry.js"

export async function restart(name?: string) {
  const recording = await request((await resolveInstance(name)).control, "restart")
  console.log(recording ?? "success")
}
