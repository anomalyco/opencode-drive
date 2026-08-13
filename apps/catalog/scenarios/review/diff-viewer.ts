import { join } from "node:path"
import { Effect } from "effect"
import type { Driver } from "opencode-drive/driver"
import { defineExecutableFlow } from "../../catalog/flow"
import { taxonomies } from "../../catalog/authored/taxonomies"

export const diffViewerFlow = defineExecutableFlow(
  taxonomies,
  {
    id: "diff-viewer-lifecycle",
    title: "Diff viewer",
    group: { id: "review", label: "Review" },
    description: "Compare the empty working-tree view with a populated file diff.",
  },
  ({ state, program }) => {
    const empty = state("diff-viewer", {
      screen: {
        title: "Diff viewer (empty)",
        category: "session",
        screenLabels: ["diff-review"],
        uiElements: ["full-screen-view", "list", "keyboard-hints", "empty-state"],
        surfaces: "full-screen",
        patterns: "list",
        features: ["diff", "session"],
        states: "empty",
      },
      step: { title: "Open an empty diff", trigger: "Run /diff" },
    })
    const populated = state("diff-viewer-populated", {
      screen: {
        title: "Diff viewer (populated)",
        category: "session",
        screenLabels: ["diff-review"],
        uiElements: ["full-screen-view", "list", "keyboard-hints"],
        surfaces: "full-screen",
        patterns: "list",
        features: ["diff", "session"],
        states: "populated",
      },
      step: { title: "Inspect a changed file", trigger: "Modify a tracked file" },
    })

    return program([empty, populated], ({ driver, checkpoint }) =>
      Effect.gen(function* () {
        yield* openDiff(driver)
        yield* driver.ui.waitFor("0 files")
        yield* checkpoint(empty)
        yield* driver.ui.press("escape")
        yield* Effect.promise(() => Bun.write(join(driver.artifacts, "files", "fixture.txt"), "before\nafter\n"))
        yield* openDiff(driver)
        yield* driver.ui.waitFor("after", { timeout: 15_000 })
        yield* checkpoint(populated)
        yield* driver.ui.press("escape")
      }),
    )
  },
)

const openDiff = Effect.fn("Catalog.openDiff")(function* (driver: Driver) {
  yield* driver.ui.submit("/diff")
  yield* driver.ui.waitFor("Diff working tree")
})
