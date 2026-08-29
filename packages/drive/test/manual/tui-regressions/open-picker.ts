import assert from "node:assert/strict"
import { Effect, Stream } from "effect"
import { defineScript, Llm } from "../../../src/index.js"
import { appeared, settled } from "./support.js"
import { saveFailure } from "./state-machine.js"

// Each case gets a fresh server and TUI. The SDK and UI RPC channel stay clean;
// only production TUI HTTP/SSE crosses Drive's coarse TCP chaos proxy.
const scenario = process.env.OPENCODE_DRIVE_OPEN_CASE ?? "cold"
const cols = Number(process.env.OPENCODE_DRIVE_COLS ?? 100)
const seed = Number(process.env.OPENCODE_DRIVE_SEED ?? 1)

export default defineScript({
  launch: "manual",
  network: true,
  project: {
    git: true,
    files: {
      "README.md": "# Open picker fixture\n",
      "archive/README.md": "# Archive fixture\n",
      "archive/zen/README.md": "# Moved fixture\n",
    },
  },
  config: { autoupdate: false, username: "Drive" },
  tuiConfig: {
    session: { new_location: "inherit" },
    keybinds: { "session.new": "ctrl+n" },
  },
  tui: { viewport: { cols, rows: 36 } },
  run: ({ server, tuis, network, llm, artifacts }) =>
    Effect.scoped(
      Effect.gen(function* () {
        assert(["cold", "warm", "dispose", "selection", "deletion", "failure"].includes(scenario))
        yield* Effect.forEach(
          [
            ["init", "--initial-branch=main"],
            ["add", "README.md"],
            ["commit", "-m", "Archive fixture"],
          ],
          (args) =>
            Effect.tryPromise(async () => {
              const process = Bun.spawn(
                ["git", "-c", "user.name=Drive", "-c", "user.email=drive@example.com", ...args],
                {
                  cwd: `${artifacts}/files/archive`,
                  env: {
                    ...Bun.env,
                    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
                    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
                  },
                  stdout: "ignore",
                  stderr: "pipe",
                },
              )
              assert.equal(await process.exited, 0, await new Response(process.stderr).text())
            }),
        )
        const opencode = yield* server.launch()
        const location = yield* opencode.location.get({ location: { directory: `${artifacts}/files` } })
        const archive = yield* opencode.location.get({ location: { directory: `${artifacts}/files/archive` } })
        assert.notEqual(archive.project.id, location.project.id, "archive must be a distinct Git project")
        const model = (yield* opencode.model.default({ location })).data
        const agent = (yield* opencode.agent.list({ location })).data.find((agent) => agent.id === "build")
        assert(model)
        assert(agent)
        // Created before frontend launch: these are neither open tabs nor event-
        // hydrated sessions. Distinct titles fit the 44-column picker as well.
        const older = yield* opencode.session
          .create({
            title: "Atlas archive",
            location: archive,
            model: { providerID: model.providerID, id: model.id },
            agent: agent.id,
          })
          .pipe(Effect.map((session) => ({ id: session.id, location: session.location, title: "Atlas archive" })))
        const newer = yield* opencode.session
          .create({
            title: "Atlas parser",
            location,
            model: { providerID: model.providerID, id: model.id },
            agent: agent.id,
          })
          .pipe(Effect.map((session) => ({ id: session.id, location: session.location, title: "Atlas parser" })))
        const observer = yield* tuis.launch("picker")
        const ui = observer.ui
        const trace: string[] = []
        const checkpoint = (name: string) => {
          trace.push(name)
          console.error(JSON.stringify({ scenario, cols, seed, checkpoint: name }))
        }
        const evidence = () =>
          Effect.all({
            sessions: opencode.session.list({ limit: 100, order: "desc" }),
            olderMessages: opencode.message.list({ sessionID: older.id, limit: 100 }).pipe(Effect.option),
            newerMessages: opencode.message.list({ sessionID: newer.id, limit: 100 }),
            snapshot: ui.snapshot(),
            state: ui.state(),
          })
        const context = { ui, artifacts, evidence }
        const absent = (text: string) => ui.matches(text).pipe(Effect.map((visible) => !visible))
        const composer = () =>
          ui.waitFor(
            (state) => state.elements.some((element) => element.focused && element.id.startsWith("textarea-")),
            { timeout: 15_000 },
          )
        const filter = (value: string) =>
          Effect.gen(function* () {
            yield* ui.type(value)
            const input = yield* ui.getElement({ focused: true })
            assert(input.id.startsWith("input-"))
            yield* ui.waitFor(() =>
              ui.capture().pipe(
                Effect.map(
                  (frame) =>
                    frame.lines[input.y]?.spans
                      .map((span) => span.text)
                      .join("")
                      .slice(input.x, input.x + input.width)
                      .trim() === value,
                ),
              ),
            )
          })
        const select = (title: string) =>
          Effect.gen(function* () {
            const input = yield* ui.getElement({ focused: true })
            const frame = yield* ui.capture()
            const row = frame.lines.findIndex(
              (line, index) =>
                index > input.y &&
                line.spans
                  .map((span) => span.text)
                  .join("")
                  .includes(title),
            )
            assert(row > input.y, "target row is not visible")
            // Fuzzy matching can reorder whole categories, including project path
            // matches. Navigate real interactive row positions, not guessed rank.
            const rows = new Set(
              (yield* ui.state()).elements
                .filter(
                  (element) =>
                    element.clickable &&
                    element.height === 1 &&
                    element.width >= input.width &&
                    element.y > input.y &&
                    element.y <= row,
                )
                .map((element) => element.y),
            )
            assert(rows.has(row), "target row has no interactive element")
            checkpoint(`select:${title}:index=${rows.size - 1}`)
            yield* ui.arrow("down")
            yield* ui.arrow("up")
            yield* Effect.forEach(Array.from({ length: rows.size - 1 }), () => ui.arrow("down"))
          })
        const ready = () => ui.waitFor(() => absent("Refreshing sessions and projects"), { timeout: 15_000 })
        const open = () =>
          Effect.gen(function* () {
            yield* ui.press("o", { ctrl: true })
            yield* ui.waitFor("Search sessions and", { timeout: 3_000 })
          })
        const close = () =>
          Effect.gen(function* () {
            yield* ui.press("escape")
            yield* ui.waitFor(() => absent("Search sessions and"))
          })
        const warm = () =>
          Effect.gen(function* () {
            yield* open()
            yield* ui.waitFor(older.title)
            yield* ui.waitFor(newer.title)
            yield* ready()
          })
        // No selected-row semantic surface exists in DialogSelect. Prove the
        // chosen identity by a real TUI prompt projected into that exact session.
        const verifyDestination = (session: typeof older) =>
          Effect.gen(function* () {
            yield* composer()
            yield* ui.waitFor("Simulated Model", { timeout: 15_000 })
            const marker = `OPEN_${scenario}_${seed}`
            yield* ui.submit(marker)
            yield* ui.waitFor("OPEN_REPLY_DONE", { timeout: 20_000 })
            yield* opencode.session.wait({ sessionID: session.id })
            const messages = yield* opencode.message.list({ sessionID: session.id, limit: 100 })
            assert.equal(
              messages.data.filter((message) => message.type === "user" && message.text === marker).length,
              1,
              "Enter navigated to a different session",
            )
            assert.deepEqual((yield* opencode.session.get({ sessionID: session.id })).location, session.location)
          })
        yield* llm.serve((request) =>
          Stream.make(
            Llm.text(JSON.stringify(request.body).includes("title generator") ? "Atlas check" : "OPEN_REPLY_DONE"),
          ),
        )
        yield* Effect.gen(function* () {
          yield* composer()
          assert(yield* absent(older.title), "fixture unexpectedly became an open tab")
          assert(yield* absent(newer.title), "fixture unexpectedly became an open tab")

          if (scenario === "cold") {
            checkpoint("cold-open-with-both-reads-blocked")
            yield* network.set({ blackhole: true })
            yield* open()
            yield* ui.waitFor("Refreshing sessions and")
            assert(yield* absent("No items available"))
            assert(yield* absent("No recent sessions or projects"))
            assert(yield* absent(older.title), "cold fixture was already hydrated")
            yield* filter("not-a-fixture")
            yield* ui.waitFor("Searching sessions and")
            assert(yield* absent("No matches"), "pending reads were misreported as empty")
            yield* ui.screenshot("cold-blocked")
            checkpoint("escape-before-heal")
            yield* ui.press("escape")
            yield* composer()
            yield* network.clear()
            assert(
              !(yield* appeared(ui, "Search sessions and", { timeout: 1_500 })),
              "late response reopened the picker",
            )
            assert((yield* settled(ui)).stable)
          }

          if (scenario === "warm") {
            yield* warm()
            yield* ui.enter()
            yield* composer()
            yield* ui.waitFor(newer.title)
            checkpoint("move-cached-session-while-picker-dismissed")
            const moved = yield* opencode.location.get({ location: { directory: `${artifacts}/files/archive/zen` } })
            yield* opencode.session.move({ sessionID: older.id, directory: moved.directory })
            yield* opencode.session.wait({ sessionID: older.id })
            const movedSession = yield* opencode.session.get({ sessionID: older.id })
            assert.equal(movedSession.location.directory, moved.directory)
            // This visible rename is later on the same ordered SSE stream; seeing
            // it proves this TUI processed the dismissed picker's earlier move.
            yield* opencode.session.rename({ sessionID: newer.id, title: "Atlas barrier" })
            yield* ui.waitFor("Atlas barrier")
            checkpoint("retained-unhydrated-rows-usable-under-blackhole")
            yield* network.set({ blackhole: true })
            yield* open()
            yield* ui.waitFor(older.title)
            yield* ui.waitFor("Refreshing sessions and")
            yield* filter("Atlas archive")
            yield* ui.waitFor(() => absent("Search sessions and"))
            yield* select(older.title)
            const input = yield* ui.getElement({ focused: true })
            checkpoint("repeat-ctrl-o-preserves-filter-and-selected-identity")
            yield* ui.press("o", { ctrl: true })
            assert(yield* absent("Search sessions and"), "repeat Ctrl-O reset the filter")
            assert.equal((yield* ui.getElement({ focused: true })).num, input.num, "repeat Ctrl-O replaced the picker")
            yield* ui.screenshot("warm-repeat-blocked")
            yield* ui.enter()
            yield* ui.waitFor(() => absent("Refreshing sessions and"))
            assert(yield* absent("Sessions"), "cached row could not close the picker while partitioned")
            // Inspect the local location ref through the new-session footer
            // before a healed session GET could correct a stale cached placement.
            yield* ui.press("n", { ctrl: true })
            yield* ui.getElement("prompt.footer.location")
            yield* ui.waitFor("zen")
            yield* ui.screenshot("warm-moved-location-before-heal")
            checkpoint("heal-then-prove-inherited-location-and-session-identity")
            yield* network.clear()
            yield* composer()
            yield* ui.waitFor("Simulated Model", { timeout: 15_000 })
            yield* ui.submit(`OPEN_MOVED_NEW_${seed}`)
            yield* ui.waitFor("OPEN_REPLY_DONE", { timeout: 20_000 })
            const created = (yield* opencode.session.list({ limit: 100 })).data.find(
              (session) => session.id !== older.id && session.id !== newer.id,
            )
            assert(created)
            yield* opencode.session.wait({ sessionID: created.id })
            assert.deepEqual(created.location, movedSession.location, "picker lost the moved session's location")
            const messages = yield* opencode.message.list({ sessionID: created.id, limit: 100 })
            assert(
              messages.data.some((message) => message.type === "user" && message.text === `OPEN_MOVED_NEW_${seed}`),
            )
            yield* open()
            yield* filter("Atlas archive")
            yield* ui.waitFor(older.title)
            yield* select(older.title)
            yield* ui.enter()
            yield* verifyDestination({ ...older, location: movedSession.location })
          }

          if (scenario === "dispose") {
            yield* warm()
            yield* close()
            yield* network.set({ blackhole: true })
            yield* open()
            yield* ui.waitFor("Refreshing sessions and")
            yield* filter("discarded-query")
            checkpoint("dispose-old-pending-refresh-and-reopen")
            yield* ui.press("escape")
            yield* open()
            yield* ui.waitFor(older.title)
            yield* filter("Atlas archive")
            yield* opencode.session.rename({ sessionID: newer.id, title: "Boreal updated" })
            yield* network.clear()
            yield* ready()
            assert(yield* absent("discarded-query"))
            assert(yield* absent("Boreal updated"), "disposed refresh reset the new query")
            yield* ui.press("escape")
            yield* open()
            yield* ready()
            yield* ui.waitFor("Boreal updated")
            assert(yield* absent(newer.title), "old refresh poisoned the retained snapshot")
            yield* close()
            yield* network.set({ blackhole: true })
            yield* open()
            yield* ui.waitFor("Boreal updated")
            assert(yield* absent(newer.title))
            yield* ui.screenshot("dispose-retained-latest")
            yield* close()
            yield* network.clear()
            assert(!(yield* appeared(ui, "Search sessions and", { timeout: 1_500 })))
          }

          if (scenario === "selection") {
            yield* warm()
            yield* close()
            yield* network.set({ blackhole: true })
            yield* open()
            yield* ui.waitFor(older.title)
            yield* ui.arrow("down")
            checkpoint("selected-row-survives-new-recent-row-arrival")
            yield* opencode.session.create({ title: "Boreal newest", location })
            yield* network.clear()
            yield* ui.waitFor("Boreal newest")
            yield* ready()
            yield* ui.screenshot("selection-refreshed")
            yield* ui.enter()
            yield* verifyDestination(older)
          }

          if (scenario === "deletion") {
            yield* warm()
            checkpoint("server-delete-evicts-open-and-retained-rows")
            yield* opencode.session.remove({ sessionID: older.id })
            // Row removal is the causal barrier that SSE deletion reached this
            // TUI. The next open cannot use a healthy list to hide a stale cache.
            yield* ui.waitFor(() => absent(older.title))
            yield* close()
            yield* network.set({ blackhole: true })
            yield* open()
            yield* ui.waitFor(newer.title)
            assert(yield* absent(older.title), "deleted session returned from retained snapshot")
            const sessions = yield* opencode.session.list({ limit: 100 })
            assert(!sessions.data.some((session) => session.id === older.id))
            yield* ui.screenshot("deletion-blocked")
            yield* ui.enter()
            yield* network.clear()
            yield* verifyDestination(newer)
          }

          if (scenario === "failure") {
            yield* warm()
            yield* close()
            yield* network.set({ blackhole: true })
            yield* open()
            yield* ui.waitFor("Refreshing sessions and")
            checkpoint("pending-reads-fail-but-retained-rows-remain")
            yield* network.set({ refuseNew: true })
            assert((yield* network.killConnections()) > 0)
            yield* ui.waitFor("Could not refresh", { timeout: 5_000 })
            assert(yield* ui.matches(older.title), "refresh failure discarded cached rows")
            assert(yield* ui.matches(newer.title), "refresh failure discarded cached rows")
            yield* ui.screenshot("failure-inline-error")
            yield* network.clear()
            yield* ui.press("escape")
            checkpoint("healthy-reopen-recovers")
            yield* open()
            yield* ui.waitFor(older.title)
            yield* ready()
            assert(yield* absent("Could not refresh"), "healthy refresh retained the error")
            yield* filter("Atlas archive")
            yield* select(older.title)
            yield* ui.screenshot("failure-recovered-filtered")
            yield* ui.enter()
            yield* verifyDestination(older)
          }

          yield* ui.screenshot(`${scenario}-passed`)
          yield* Effect.tryPromise(() =>
            Bun.write(
              `${artifacts}/open-picker-report.json`,
              JSON.stringify({ scenario, cols, seed, trace, passed: true }, null, 2),
            ),
          )
          console.log(JSON.stringify({ scenario, cols, seed, passed: true, artifacts }))
        }).pipe(
          Effect.catchCause((cause) =>
            saveFailure(context, { scenario, cols, seed, trace, cause: String(cause) }).pipe(
              Effect.andThen(Effect.failCause(cause)),
            ),
          ),
          Effect.ensuring(network.clear().pipe(Effect.orDie)),
        )
      }),
    ),
})
