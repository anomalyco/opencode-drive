import { Effect, Llm, defineScript } from "opencode-drive"

// Run against a source checkout or a packaged Desktop:
//   opencode-drive start --script test/manual/gui-smoke.ts --dev "$OPENCODE_DEV"
//   OPENCODE_GUI_APP=/Applications/OpenCode.app opencode-drive start --script test/manual/gui-smoke.ts
export default defineScript({
  launch: "gui",
  gui: process.env.OPENCODE_GUI_APP ? { app: process.env.OPENCODE_GUI_APP } : {},
  project: {
    git: true,
    files: { "README.md": "# GUI smoke test\n" },
  },
  run: ({ gui, llm }) =>
    Effect.gen(function* () {
      yield* llm.queue(Llm.text("GUI_SMOKE_OK"))
      yield* Effect.promise(async () => {
        const overlay = gui.locator('[data-component="startup-overlay"]')
        if (await overlay.count()) await overlay.waitFor({ state: "hidden" })
        const editor = gui.locator('[data-component="composer-editor"]')
        await editor.waitFor()
        await editor.fill("Run the GUI smoke test.")
        await editor.press("Enter")
        await gui.getByText("GUI_SMOKE_OK", { exact: true }).waitFor()
      })
    }),
})
