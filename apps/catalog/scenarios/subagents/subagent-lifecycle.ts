import { Effect, Stream } from "effect"
import { Llm, type JsonValue } from "opencode-drive"
import type { Driver } from "opencode-drive/driver"
import { defineExecutableFlow } from "../../catalog/flow"
import { taxonomies } from "../../catalog/authored/taxonomies"

export const subagentLifecycleFlow = defineExecutableFlow(
  taxonomies,
  {
    id: "subagent-lifecycle",
    title: "Subagent lifecycle",
    group: { id: "subagents", label: "Subagents" },
    description: "Delegate work, observe its completion, and open the child session.",
  },
  ({ state, program }) => {
    const running = state("subagent-running", {
      screen: {
        title: "Subagent running",
        category: "session",
        screenLabels: ["subagent-activity"],
        uiElements: ["transcript", "tool-card", "status-indicator"],
        surfaces: "inline",
        patterns: "status",
        features: ["agent", "subagent"],
        states: "running",
      },
      step: { title: "Subagent runs" },
    })
    const completed = state("subagent-completed", {
      screen: {
        title: "Subagent completed",
        category: "session",
        screenLabels: ["subagent-activity"],
        uiElements: ["transcript", "tool-card", "confirmation"],
        surfaces: "inline",
        patterns: "status",
        features: ["agent", "subagent"],
        states: "success",
      },
      step: { title: "Subagent completes" },
    })
    const panelActive = state("subagent-panel-active", {
      screen: {
        title: "Subagents panel (active)",
        category: "session",
        screenLabels: ["subagent-activity"],
        uiElements: ["panel", "tabs", "list", "keyboard-hints", "status-indicator"],
        surfaces: "panel",
        patterns: "status",
        features: ["agent", "subagent", "session"],
        states: ["populated", "running"],
      },
      step: { title: "Inspect active subagents", trigger: "Open the Subagents panel" },
    })
    const panelInactive = state("subagent-panel-inactive", {
      screen: {
        title: "Subagents panel (inactive)",
        category: "session",
        screenLabels: ["subagent-activity"],
        uiElements: ["panel", "tabs", "list", "keyboard-hints", "confirmation"],
        surfaces: "panel",
        patterns: "list",
        features: ["agent", "subagent", "session"],
        states: ["populated", "success"],
      },
      step: { title: "Inspect inactive subagents", trigger: "Toggle show inactive" },
    })
    const shellEmpty = state("shell-panel-empty", {
      screen: {
        title: "Shell panel (empty)",
        category: "session",
        screenLabels: ["shell-activity"],
        uiElements: ["panel", "tabs", "list", "keyboard-hints", "empty-state"],
        surfaces: "panel",
        patterns: "list",
        features: ["shell", "session"],
        states: "empty",
      },
      step: { title: "Inspect the empty Shell panel", trigger: "Switch to the Shell tab" },
    })
    const shellRunning = state("shell-panel-running", {
      screen: {
        title: "Shell panel (running)",
        category: "session",
        screenLabels: ["shell-activity"],
        uiElements: ["panel", "tabs", "list", "keyboard-hints", "status-indicator"],
        surfaces: "panel",
        patterns: "status",
        features: ["shell", "session"],
        states: ["populated", "running"],
      },
      step: { title: "Inspect a running shell command" },
    })
    const session = state("subagent-session", {
      screen: {
        title: "Subagent session",
        category: "session",
        screenLabels: ["subagent-activity", "session-list"],
        uiElements: ["transcript", "panel", "status-indicator"],
        surfaces: ["full-screen", "panel"],
        patterns: "status",
        features: ["agent", "subagent", "session"],
        states: "populated",
      },
      step: { title: "Open the subagent session" },
    })

    return program(
      [running, panelActive, completed, panelInactive, shellEmpty, shellRunning, session],
      ({ driver, checkpoint }) =>
        Effect.gen(function* () {
          let phase = 0
          yield* driver.llm.serve((request) => {
            if (JSON.stringify(request.body).includes("title generator")) {
              return Stream.make(Llm.text("Delegating ledger lifecycle"))
            }
            if (phase === 0) {
              phase++
              const tool = subagentTool(request.body)
              return Stream.make(
                Llm.reasoning("I will delegate the ledger inspection."),
                Llm.toolCall({
                  index: 0,
                  id: "call_catalog_subagent",
                  name: tool,
                  input: subagentInput(tool),
                }),
                Llm.finish("tool-calls"),
              )
            }
            if (phase === 1) {
              phase++
              return Stream.make(
                Llm.pause(8_000),
                Llm.text("The child inspected src/ledger.ts and calculated total 42."),
              )
            }
            phase++
            return Stream.make(Llm.text("Subagent completed the ledger lifecycle."))
          })

        yield* driver.ui.submit("Use a subagent to inspect src/ledger.ts and calculate the total.")
        yield* driver.ui.waitFor("Inspect ledger lifecycle", { timeout: 15_000 })
        yield* checkpoint(running)
        yield* openSubagentsPanel(driver)
        yield* driver.ui.waitFor("Running")
        yield* checkpoint(panelActive)
        yield* driver.ui.press("escape")
        yield* driver.ui.waitFor("Subagent completed the ledger lifecycle.", { timeout: 30_000 })
        yield* checkpoint(completed)
        yield* openSubagentsPanel(driver)
        yield* driver.ui.press("a", { ctrl: true })
        yield* driver.ui.waitFor("Inspect ledger lifecycle")
        yield* checkpoint(panelInactive)
        yield* driver.ui.arrow("right")
        yield* driver.ui.waitFor("No shell commands")
        yield* checkpoint(shellEmpty)
        yield* driver.ui.press("escape")
        const parent = (yield* driver.opencode.session.list({ limit: 10 })).data.find((item) => !item.parentID)
        if (!parent) return yield* Effect.fail(new Error("Shell panel capture requires the parent session"))
        const shell = yield* driver.opencode.shell.create({
          command: "sleep 30",
          timeout: 60_000,
          metadata: { sessionID: parent.id },
        })
        yield* Effect.sleep(300)
        yield* openSubagentsPanel(driver)
        yield* driver.ui.arrow("right")
        yield* driver.ui.waitFor("sleep 30")
        yield* checkpoint(shellRunning)
        yield* driver.ui.press("escape")
        yield* driver.opencode.shell.remove({ id: shell.data.id })
        yield* openSubagentsPanel(driver)
        yield* driver.ui.press("a", { ctrl: true })
        yield* driver.ui.waitFor("Inspect ledger lifecycle")
        yield* driver.ui.enter()
        yield* driver.ui.waitFor("calculated total 42", { timeout: 15_000 })
          yield* checkpoint(session)
        }),
    )
  },
)

const openSubagentsPanel = Effect.fn("Catalog.openSubagentsPanel")(function* (driver: Driver) {
  yield* driver.ui.press("p", { ctrl: true })
  yield* driver.ui.waitFor("Commands")
  yield* driver.ui.type("Toggle subagent picker")
  yield* driver.ui.waitFor("Toggle subagent picker")
  yield* driver.ui.enter()
  yield* driver.ui.waitFor("Subagents")
})

function subagentTool(body: JsonValue) {
  const names = offeredTools(body)
  if (names.includes("subagent")) return "subagent"
  if (names.includes("task")) return "task"
  throw new Error(`OpenCode did not offer a subagent tool: ${names.join(", ")}`)
}

function subagentInput(tool: string): JsonValue {
  const input = {
    description: "Inspect ledger lifecycle",
    prompt: "Read src/ledger.ts and report its exports, values, and calculated total.",
  }
  if (tool === "subagent") return { ...input, agent: "researcher" }
  return { ...input, subagent_type: "researcher" }
}

function offeredTools(body: JsonValue) {
  if (!isJsonObject(body) || !Array.isArray(body.tools)) return []
  return body.tools.flatMap((tool) => {
    if (!isJsonObject(tool) || !isJsonObject(tool.function)) return []
    return typeof tool.function.name === "string" ? [tool.function.name] : []
  })
}

function isJsonObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
