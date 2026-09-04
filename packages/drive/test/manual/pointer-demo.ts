import { Effect } from "effect"
import { Frontend, OpenCodeDriver } from "opencode-drive"

// OPENCODE_DEV=/path/to/opencode OPENCODE_DRIVE_MEDIA_DIR=$PWD/.drive-output \
//   bun run drive run test/manual/pointer-demo.ts
// Real production devtools controls; no simulated model calls or visual hover substitutes.
export default OpenCodeDriver.use({
  opencode: { dev: process.env.OPENCODE_DEV, compatibility: "required" },
  tui: { recording: true, pointerOverlay: true, viewport: { cols: 100, rows: 30 } },
  tuiConfig: { theme: { name: "opencode", mode: "dark" } },
  keepArtifacts: true,
}, ({ ui, tui, artifacts }) => Effect.gen(function* () {
  console.log("artifacts:", artifacts)
  const recording = tui.recording
  if (!recording) return yield* Effect.fail(new Error("recording required"))
  yield* ui.waitFor("Simulated Model")
  yield* ui.mouse({ action: "move", x: 80, y: 14 })
  yield* recording.mark("Target-relative click opens the production Theme panel")
  yield* Effect.sleep(800)
  yield* ui.mouse({ action: "move", x: 16, y: 29 })
  yield* Effect.sleep(500)
  const theme = (yield* ui.state()).elements.find((element) => element.x === 16 && element.y === 29 && element.width === 7)
  if (!theme) return yield* Effect.fail(new Error("Theme toolbar element unavailable"))
  yield* recording.mark("Target-relative click opens Theme; pointer lands on the actual cell")
  yield* ui.click(theme, { x: 3, y: 0 })
  yield* ui.waitFor("Switch to light")
  const before = yield* ui.capture()
  const light = locate(before, "Switch to light")
  yield* Effect.sleep(350)
  yield* ui.mouse({ action: "move", ...light })
  yield* recording.mark("Real hover highlights the action without clicking")
  yield* ui.waitFor(() => ui.capture().pipe(Effect.map((hover) =>
    background(before, light.x, light.y) !== background(hover, light.x, light.y))), { timeout: 2_000 })
  console.log("hover screenshot:", yield* ui.screenshot("pointer-hover"))
  yield* Effect.sleep(700)
  yield* recording.mark("Mouse leaves the action; native hover clears without clicking")
  const selected = yield* ui.capture()
  yield* ui.mouse({ action: "move", x: 80, y: 14 })
  yield* ui.waitFor(() => ui.capture().pipe(Effect.map((outside) =>
    background(selected, light.x, light.y) !== background(outside, light.x, light.y))), { timeout: 2_000 })
  console.log("leave screenshot:", yield* ui.screenshot("pointer-leave"))
  yield* Effect.sleep(800)
  yield* ui.mouse({ action: "move", ...light })
  yield* Effect.sleep(350)
  yield* recording.mark("Native down / up — nearby clicks keep the cursor visible")
  yield* ui.mouse({ action: "down", ...light })
  yield* ui.mouse({ action: "up", ...light })
  yield* ui.waitFor("Switch to dark")
  yield* Effect.sleep(750)
  const dark = locate(yield* ui.capture(), "Switch to dark")
  yield* ui.mouse({ action: "down", ...dark })
  yield* ui.mouse({ action: "up", ...dark })
  yield* ui.waitFor("Switch to light")
  yield* Effect.sleep(1_000)
  yield* recording.mark("The recorded pointer fades; real input timing is unchanged")
  yield* Effect.sleep(1_200)
  yield* ui.mouse({ action: "down", x: 19, y: 29 })
  yield* ui.mouse({ action: "up", x: 19, y: 29 })
  yield* recording.mark("Narrow viewport — input and pointer use the resized terminal")
  yield* ui.resize({ cols: 70, rows: 24 })
  yield* Effect.sleep(500)
  yield* ui.mouse({ action: "move", x: 19, y: 23 })
  yield* Effect.sleep(350)
  yield* ui.mouse({ action: "down", x: 19, y: 23 })
  yield* ui.mouse({ action: "up", x: 19, y: 23 })
  yield* ui.waitFor("Switch to light")
  yield* Effect.sleep(1_400)
  console.log("video:", yield* recording.finish())
}))

function locate(frame: Frontend.CapturedFrame, text: string) {
  const row = frame.lines.findIndex((line) => line.spans.map((span) => span.text).join("").includes(text))
  if (row < 0) throw new Error(`missing text: ${text}`)
  const line = frame.lines[row]?.spans.map((span) => span.text).join("") ?? ""
  // Click the action's blank area rather than beginning native text selection.
  return { x: line.indexOf(text) + text.length + 2, y: row }
}

function background(frame: Frontend.CapturedFrame, x: number, y: number) {
  let column = 0
  for (const span of frame.lines[y]?.spans ?? []) {
    column += span.width
    if (column > x) return JSON.stringify(span.bg)
  }
  throw new Error("cell outside frame")
}
