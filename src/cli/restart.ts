import { request } from "./control.js"
import { resolveInstance } from "./registry.js"

export async function restart(name?: string) {
  await request((await resolveInstance(name)).control, "restart")
  console.log("success")
}
