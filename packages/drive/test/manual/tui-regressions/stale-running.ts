import { Deferred, Effect, Random, Schedule, Stream } from "effect"
import { defineScript, Llm, type JsonValue } from "../../../src/index.js"
import type { OpenCode } from "../../../src/index.js"
import { run, saveFailure } from "./state-machine.js"

// Seeded "stale running" gauntlet. The open picker (Ctrl-O) draws a spinner in
// a root session's gutter when the root or any descendant is running in the
// TUI's client store. That store is fed by live execution events and replaced
// by a `GET /api/session/active` snapshot on every reconnect.
//
// Root sessions and prompts go through the clean SDK, so the TUI is a pure
// observer. Subagents run in the foreground or background; each child either
// streams a short reply or hangs (optionally with no output at all) until
// released. Children and roots are interrupted from the SDK or the TUI while
// latency, blackholes, and connection kills degrade only the TUI's traffic.
//
// Invariant (checked by `verify`): once the server's active set is stable and
// the network is healed, every root's picker spinner equals "root or a
// descendant is in /api/session/active", within a convergence window.
//
//   OPENCODE_DRIVE_SEED=42 OPENCODE_DRIVE_STEPS=30 \
//     bun run --cwd packages/drive drive start --daemon --name stale-running \
//     --script test/manual/tui-regressions/stale-running.ts \
//     --dev "$OPENCODE_DEV"

const seed = readInteger("OPENCODE_DRIVE_SEED", 1, Number.MAX_SAFE_INTEGER)
const steps = readInteger("OPENCODE_DRIVE_STEPS", 30, 1_000)
const SPINNER = new Set(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏", "⋯"])
const NAMES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]

type SessionID = Effect.Success<ReturnType<OpenCode["session"]["create"]>>["id"]

interface Child {
  readonly n: number
  readonly root: string
  readonly background: boolean
  readonly mode: "paced" | "hung" | "silent"
  readonly released: boolean
}

interface Model {
  readonly roots: ReadonlyArray<{ readonly name: string; readonly id: SessionID }>
  readonly children: ReadonlyArray<Child>
  readonly dispatched: number
  readonly viewing?: string
  readonly conditions: "clear" | "latency" | "blackhole"
  readonly lastTuiActionAt: number
  readonly coverage: Record<string, number>
}

export default defineScript({
  network: true,
  llm: { settlementTimeout: 180_000 },
  project: { git: true, files: { "README.md": "# Stale running fixture\n" } },
  config: { autoupdate: false, username: "Drive" },
  tui: { viewport: { cols: 120, rows: 40 } },
  run: ({ ui, llm, network, opencode, artifacts }) =>
    Effect.gen(function* () {
      const gates = new Map<number, Deferred.Deferred<void>>()
      const modes = new Map<number, Child>()
      const tokens: Array<{ token: string; kind: "dispatch" | "followup" | "child" | "plain"; n: number }> = []

      yield* llm.serve((request) => {
        const body = JSON.stringify(request.body)
        if (body.includes("title generator")) return Stream.make(Llm.text("Gauntlet untitled"))
        let best: (typeof tokens)[number] | undefined
        let position = -1
        for (const candidate of tokens) {
          const index = body.lastIndexOf(candidate.token)
          if (index > position) {
            position = index
            best = candidate
          }
        }
        if (best === undefined) return Stream.make(Llm.text("unmatched request"))
        if (best.kind === "plain")
          return Stream.make(Llm.text("plain reply "), Llm.pause(600), Llm.text("plain reply done"))
        if (best.kind === "followup") return Stream.make(Llm.text("parent round complete"))
        if (best.kind === "dispatch") {
          const child = modes.get(best.n)!
          const tool = offeredTools(request.body).includes("subagent") ? "subagent" : "task"
          return Stream.make(
            Llm.toolCall({
              index: 0,
              id: `call_g${best.n}z`,
              name: tool,
              input:
                tool === "subagent"
                  ? {
                      agent: "general",
                      description: `Gauntlet child ${best.n}`,
                      prompt: `C${best.n}Q do the delegated work`,
                      ...(child.background ? { background: true } : {}),
                    }
                  : {
                      subagent_type: "general",
                      description: `Gauntlet child ${best.n}`,
                      prompt: `C${best.n}Q do the delegated work`,
                    },
            }),
            Llm.finish("tool-calls"),
          )
        }
        const child = modes.get(best.n)!
        const gate = gates.get(best.n)!
        const tail = Stream.fromEffect(Deferred.await(gate)).pipe(
          Stream.flatMap(() => Stream.make(Llm.text("child finished"))),
        )
        if (child.mode === "paced")
          return Stream.make(Llm.text("child working "), Llm.pause(1_200), Llm.text("child finished"))
        if (child.mode === "silent") return tail
        return Stream.make(Llm.text("child working ")).pipe(Stream.concat(tail))
      })

      const location = yield* opencode.location.get({ location: { directory: `${artifacts}/files` } })
      const catalog = yield* Effect.repeat(
        Effect.all({
          model: opencode.model.default({ location }).pipe(Effect.map((output) => output.data)),
          agent: opencode.agent
            .list({ location })
            .pipe(Effect.map((output) => output.data.find((agent) => agent.id === "build"))),
        }),
        {
          until: (value) => value.model !== undefined && value.agent !== undefined,
          schedule: Schedule.spaced(50),
        },
      ).pipe(
        Effect.timeoutOrElse({
          duration: 15_000,
          orElse: () => Effect.fail(new Error("timed out waiting for plugin activation")),
        }),
      )

      const families = Effect.gen(function* () {
        const sessions = (yield* opencode.session.list({ limit: 500 })).data
        const parent = new Map(sessions.map((session) => [session.id as string, session.parentID as string | undefined]))
        const root = (id: string) => {
          let current = id
          const seen = new Set<string>()
          while (parent.get(current) && !seen.has(current)) {
            seen.add(current)
            current = parent.get(current)!
          }
          return current
        }
        return { sessions, root }
      })

      const serverView = (model: Model) =>
        Effect.gen(function* () {
          const active = Object.keys(yield* opencode.session.active()).toSorted()
          const family = yield* families
          const expected = Object.fromEntries(
            model.roots.map((item) => [item.name, active.some((id) => family.root(id) === item.id)]),
          )
          return { active, expected, key: JSON.stringify(active) }
        })

      const absent = (text: string) => ui.matches(text).pipe(Effect.map((visible) => !visible))
      const openPicker = (filter: string) =>
        Effect.gen(function* () {
          yield* ui.press("o", { ctrl: true })
          yield* ui.waitFor("Search sessions and", { timeout: 5_000 })
          yield* ui.type(filter)
          yield* ui.waitFor(() => absent("Refreshing sessions and projects"), { timeout: 15_000 })
        })
      const closePicker = Effect.gen(function* () {
        yield* ui.press("escape")
        yield* ui.waitFor(() => absent("Search sessions and"), { timeout: 5_000 })
      })

      const readPicker = (model: Model) =>
        Effect.gen(function* () {
          yield* openPicker("Gauntlet")
          yield* Effect.sleep(250)
          const input = yield* ui.getElement({ focused: true })
          const frame = yield* ui.capture()
          yield* closePicker
          // Only rows under the picker's filter input: the tab strip behind the dialog also
          // renders titles with a spinner, but its busy state includes queued inbox items.
          const lines = frame.lines
            .slice(input.y + 1)
            .map((line) => line.spans.map((span) => span.text).join("").slice(input.x - 4, input.x + input.width + 4))
          return Object.fromEntries(
            model.roots.map((item) => {
              const title = `Gauntlet ${item.name}`
              const line = lines.find((text) => text.includes(title))
              if (line === undefined) return [item.name, "missing" as const]
              return [item.name, [...line.slice(0, line.indexOf(title))].some((char) => SPINNER.has(char))]
            }),
          ) as Record<string, boolean | "missing">
        })

      const waitServerStable = (model: Model) =>
        Effect.gen(function* () {
          let previous = ""
          let streak = 0
          const startedAt = Date.now()
          while (Date.now() - startedAt < 45_000) {
            const view = yield* serverView(model)
            streak = view.key === previous ? streak + 1 : 0
            previous = view.key
            if (streak >= 3) return view
            yield* Effect.sleep(1_000)
          }
          return yield* Effect.fail(new Error("server active set never stabilized"))
        })

      const verify = (model: Model, phase: string) =>
        Effect.gen(function* () {
          yield* network.clear()
          yield* waitServerStable(model)
          const attempts: Array<unknown> = []
          const startedAt = Date.now()
          while (Date.now() - startedAt < 15_000) {
            const before = yield* serverView(model)
            const observed = yield* readPicker(model)
            const after = yield* serverView(model)
            attempts.push({ at: Date.now() - startedAt, before: before.expected, active: before.active, observed })
            if (before.key === after.key) {
              const mismatched = model.roots.filter((item) => observed[item.name] !== before.expected[item.name])
              if (mismatched.length === 0) {
                console.error(JSON.stringify({ phase, verified: observed, active: before.active.length }))
                return
              }
            }
            yield* Effect.sleep(1_000)
          }
          const family = yield* families
          return yield* Effect.fail(
            new StaleRunningError({
              phase,
              attempts,
              sessions: family.sessions.map((session) => ({
                id: session.id,
                parentID: session.parentID,
                title: session.title,
                outcome: session.outcome,
              })),
            }),
          )
        })

      const evidence = () =>
        Effect.gen(function* () {
          const family = yield* families
          return {
            active: yield* opencode.session.active(),
            sessions: yield* Effect.forEach(family.sessions, (session) =>
              opencode.session.inbox.list({ sessionID: session.id }).pipe(
                Effect.map((inbox) => ({
                  id: session.id,
                  parentID: session.parentID,
                  title: session.title,
                  outcome: session.outcome,
                  time: session.time,
                  inbox: inbox.map((item) => ({ id: item.id, type: item.type, delivery: item.delivery })),
                })),
              ),
            ),
          }
        })

      const bump = (model: Model, key: string) => ({ ...model.coverage, [key]: (model.coverage[key] ?? 0) + 1 })
      const childSession = (child: Child, model: Model) =>
        Effect.gen(function* () {
          const root = model.roots.find((item) => item.name === child.root)!
          const children = (yield* opencode.session.list({ parentID: root.id, limit: 100 })).data
          return children.find((session) => session.title === `Gauntlet child ${child.n}`)
        })

      const initial: Model = {
        roots: [],
        children: [],
        dispatched: 0,
        conditions: "clear",
        lastTuiActionAt: 0,
        coverage: {},
      }

      const final = yield* run<Model>({
        context: { ui, artifacts, evidence },
        initial,
        seed,
        steps,
        transitions: [
          {
            name: "create-root",
            enabled: (state) => state.roots.length < NAMES.length,
            run: (state) =>
              Effect.gen(function* () {
                const name = NAMES[state.roots.length]!
                const session = yield* opencode.session.create({
                  title: `Gauntlet ${name}`,
                  location,
                  model: { providerID: catalog.model!.providerID, id: catalog.model!.id },
                  agent: catalog.agent!.id,
                })
                return { ...state, roots: [...state.roots, { name, id: session.id }], coverage: bump(state, "roots") }
              }),
          },
          {
            name: "dispatch-subagent",
            enabled: (state) => state.roots.length > 0 && state.dispatched < 24,
            run: (state) =>
              Effect.gen(function* () {
                const root = yield* Random.choice(state.roots)
                const n = state.dispatched
                const roll = yield* Random.nextIntBetween(0, 100)
                const child: Child = {
                  n,
                  root: root.name,
                  background: (yield* Random.nextIntBetween(0, 100)) < 50,
                  mode: roll < 30 ? "paced" : roll < 65 ? "hung" : "silent",
                  released: roll < 30,
                }
                modes.set(n, child)
                gates.set(n, yield* Deferred.make<void>())
                tokens.push(
                  { token: `P${n}Q`, kind: "dispatch", n },
                  { token: `call_g${n}z`, kind: "followup", n },
                  { token: `C${n}Q`, kind: "child", n },
                )
                yield* opencode.session.prompt({ sessionID: root.id, text: `P${n}Q delegate this task` })
                return {
                  ...state,
                  dispatched: n + 1,
                  children: [...state.children, child],
                  coverage: bump(state, child.background ? "background" : "foreground"),
                }
              }),
          },
          {
            name: "plain-prompt",
            enabled: (state) => state.roots.length > 0,
            run: (state) =>
              Effect.gen(function* () {
                const root = yield* Random.choice(state.roots)
                const n = 1_000 + state.dispatched
                tokens.push({ token: `T${n}Q`, kind: "plain", n })
                yield* opencode.session.prompt({ sessionID: root.id, text: `T${n}Q just answer` })
                return { ...state, dispatched: state.dispatched + 1, coverage: bump(state, "plain") }
              }),
          },
          {
            name: "release-child",
            enabled: (state) => state.children.some((child) => !child.released),
            run: (state) =>
              Effect.gen(function* () {
                const child = yield* Random.choice(state.children.filter((item) => !item.released))
                yield* Deferred.succeed(gates.get(child.n)!, undefined)
                return {
                  ...state,
                  children: state.children.map((item) => (item.n === child.n ? { ...item, released: true } : item)),
                  coverage: bump(state, "releases"),
                }
              }),
          },
          {
            name: "interrupt-child",
            enabled: (state) => state.children.length > 0,
            run: (state) =>
              Effect.gen(function* () {
                // Interrupts are damped so verification also lands while held children still run.
                if ((yield* Random.nextIntBetween(0, 100)) < 50) return state
                const child = yield* Random.choice(state.children)
                const session = yield* childSession(child, state)
                if (session === undefined) return state
                yield* opencode.session.interrupt({ sessionID: session.id })
                return { ...state, coverage: bump(state, "childInterrupts") }
              }),
          },
          {
            name: "interrupt-root",
            enabled: (state) => state.roots.length > 0,
            run: (state) =>
              Effect.gen(function* () {
                if ((yield* Random.nextIntBetween(0, 100)) < 60) return state
                const root = yield* Random.choice(state.roots)
                yield* opencode.session.interrupt({ sessionID: root.id })
                return { ...state, coverage: bump(state, "rootInterrupts") }
              }),
          },
          {
            name: "view-root",
            enabled: (state) => state.roots.length > 0 && state.conditions === "clear",
            run: (state) =>
              Effect.gen(function* () {
                const root = yield* Random.choice(state.roots)
                yield* openPicker(`Gauntlet ${root.name}`)
                yield* ui.enter()
                yield* ui.waitFor(() => absent("Search sessions and"), { timeout: 5_000 })
                return { ...state, viewing: root.name, lastTuiActionAt: Date.now(), coverage: bump(state, "views") }
              }),
          },
          {
            name: "tui-interrupt",
            enabled: (state) => state.viewing !== undefined && state.conditions === "clear",
            run: (state) =>
              Effect.gen(function* () {
                yield* ui.press("escape")
                yield* ui.press("escape")
                return { ...state, lastTuiActionAt: Date.now(), coverage: bump(state, "tuiInterrupts") }
              }),
          },
          {
            name: "latency-window",
            enabled: (state) => state.conditions === "clear",
            run: (state) =>
              Effect.gen(function* () {
                yield* network.set({
                  latencyMs: yield* Random.nextIntBetween(100, 700),
                  jitterMs: yield* Random.nextIntBetween(0, 300),
                })
                return { ...state, conditions: "latency" as const, coverage: bump(state, "latency") }
              }),
          },
          {
            name: "blackhole-window",
            enabled: (state) => state.conditions !== "blackhole",
            run: (state) =>
              network
                .set({ blackhole: true })
                .pipe(Effect.as({ ...state, conditions: "blackhole" as const, coverage: bump(state, "blackholes") })),
          },
          {
            name: "heal",
            enabled: (state) => state.conditions !== "clear",
            run: (state) => network.clear().pipe(Effect.as({ ...state, conditions: "clear" as const })),
          },
          {
            name: "kill-connections",
            enabled: (state) => state.conditions === "clear" && Date.now() - state.lastTuiActionAt > 3_000,
            run: (state) => network.killConnections().pipe(Effect.as({ ...state, coverage: bump(state, "kills") })),
          },
          {
            name: "pause",
            enabled: () => true,
            run: (state) =>
              Random.nextIntBetween(300, 1_500).pipe(
                Effect.flatMap((ms) => Effect.sleep(ms)),
                Effect.as(state),
              ),
          },
          {
            name: "verify",
            enabled: (state) => state.roots.length > 0,
            run: (state, step) =>
              verify(state, `step-${step}`).pipe(
                Effect.as({ ...state, conditions: "clear" as const, coverage: bump(state, "verifications") }),
              ),
          },
        ],
        invariants: [
          {
            name: "control plane responds",
            check: () => ui.state().pipe(Effect.timeout(10_000), Effect.asVoid),
          },
        ],
      })

      // Terminal phase: release every held child, wait for the server to go
      // fully idle, and require the picker to show no running root.
      yield* Effect.gen(function* () {
        yield* Effect.forEach(gates.values(), (gate) => Deferred.succeed(gate, undefined), { discard: true })
        yield* network.clear()
        yield* Effect.repeat(opencode.session.active(), {
          until: (active) => Object.keys(active).length === 0,
          schedule: Schedule.spaced(500),
        }).pipe(
          Effect.timeoutOrElse({
            duration: 90_000,
            orElse: () => Effect.fail(new Error("server never went idle after releasing every child")),
          }),
        )
        if (final.roots.length > 0) yield* verify(final, "terminal")
      }).pipe(
        Effect.tapCause(() =>
          saveFailure({ ui, artifacts, evidence }, { seed, steps, phase: "terminal-verify", state: final }),
        ),
      )

      console.log(JSON.stringify({ seed, steps, verdict: "pass", coverage: final.coverage }))
    }),
})

class StaleRunningError extends Error {
  constructor(readonly details: Record<string, unknown>) {
    super(`TUI running indicators diverged from the server: ${JSON.stringify(details)}`)
  }
}

function offeredTools(body: JsonValue) {
  if (!isJsonObject(body)) return []
  const tools = body.tools
  if (!Array.isArray(tools)) return []
  return tools.flatMap((tool) => {
    if (!isJsonObject(tool)) return []
    const definition = tool.function
    if (!isJsonObject(definition) || typeof definition.name !== "string") return []
    return [definition.name]
  })
}

function isJsonObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readInteger(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name])
  if (!Number.isInteger(value) || value < 1 || value > maximum) return fallback
  return value
}
