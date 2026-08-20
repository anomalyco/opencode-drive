import { Effect, Stream } from "effect"
import { Llm } from "../../../src/index.js"
import type { OpenCode, Ui } from "../../../src/index.js"
import type { Llm as LlmControl } from "../../../src/driver/llm.js"

/**
 * Shared helpers for the tui-regressions probes. These encode the gotchas the
 * probes kept relearning:
 *
 * - LLM request bodies carry the whole conversation, so marker routing must
 *   pick the marker that appears LAST in the serialized body, never the first
 *   `includes` hit.
 * - Server admission counts are the ground truth for "did my prompt land";
 *   the screen and prompt history can both mislead (history records composer
 *   text at POST-resolution time, which may include text typed mid-flight).
 * - "Did X appear within N ms?" is a soft question: use `appeared`, which
 *   relies on wait timeouts being catchable (`UiWaitTimeoutError`).
 */

/**
 * Serves a marker-routed fake model. Replies with `reply(marker)` for the
 * marker that appears last in the request body, `title` for the title
 * generator, and `GAUNTLET_UNMATCHED_PROMPT` otherwise. Register markers with
 * the returned `track` (or let `submitMarked` do it).
 */
export const serveMarkers = (
  llm: Pick<LlmControl, "serve">,
  options: {
    readonly title: string
    readonly reply?: (marker: string) => ReturnType<Parameters<LlmControl["serve"]>[0]>
  },
) =>
  Effect.gen(function* () {
    const markers: Array<string> = []
    const reply = options.reply ?? ((marker: string) => Stream.make(Llm.text(`${marker}_DONE`)))
    yield* llm.serve((request) => {
      const body = JSON.stringify(request.body)
      if (body.includes("title generator")) return Stream.make(Llm.text(options.title))
      let marker: string | undefined
      let position = -1
      for (const candidate of markers) {
        const index = body.lastIndexOf(candidate)
        if (index > position) {
          position = index
          marker = candidate
        }
      }
      if (marker === undefined) return Stream.make(Llm.text("GAUNTLET_UNMATCHED_PROMPT"))
      return reply(marker)
    })
    return {
      markers: markers as ReadonlyArray<string>,
      track: (marker: string) => {
        markers.push(marker)
      },
    }
  })

/** A reply paced over ~2.5s so faults can land mid-stream. */
export const pacedReply = (marker: string) =>
  Stream.make(
    Llm.text(`${marker}_WORKING `),
    Llm.pause(800),
    Llm.text("streaming through the gauntlet "),
    Llm.pause(800),
    Llm.text("still streaming "),
    Llm.pause(800),
    Llm.text(`${marker}_DONE`),
  )

/**
 * Soft wait: true when `text` appears within the timeout, false when the
 * deadline passes with a responsive control plane.
 */
export const appeared = (ui: Ui, text: string, options?: { readonly timeout?: number }) =>
  ui.waitFor(text, { timeout: options?.timeout ?? 15_000 }).pipe(
    Effect.as(true),
    Effect.catchTag("UiWaitTimeoutError", () => Effect.succeed(false)),
  )

/** ID of the most recently created session. */
export const latestSessionId = (opencode: OpenCode) =>
  opencode.session.list({ limit: 1, order: "desc" }).pipe(
    Effect.flatMap((sessions) =>
      sessions.data[0] === undefined
        ? Effect.fail(new Error("no session was created"))
        : Effect.succeed(sessions.data[0].id),
    ),
  )

/**
 * How many admitted user messages contain `text` — the server-side ground
 * truth for whether a submit landed, and how often.
 */
export const admissions = (opencode: OpenCode, text: string) =>
  Effect.gen(function* () {
    const sessionID = yield* latestSessionId(opencode)
    const messages = yield* opencode.message.list({ sessionID, limit: 100, order: "desc" })
    return messages.data.filter(
      (message) => message.type === "user" && message.text.includes(text),
    ).length
  })

/**
 * Requires the terminal to stop changing within a deadline. A settled UI
 * (reply finished, interrupt processed, reconnect healed) must render
 * identically across consecutive samples: any animating spinner, ticking
 * timer, or lingering busy indicator shows up as differing rows. The cursor
 * cell is masked so a blinking caret cannot count as motion. Returns stable
 * once `samples` consecutive captures match; otherwise reports the rows that
 * were still changing when the deadline passed.
 */
export const settled = (
  ui: Ui,
  options?: {
    readonly samples?: number
    readonly intervalMs?: number
    readonly deadlineMs?: number
  },
) =>
  Effect.gen(function* () {
    const samples = options?.samples ?? 3
    const interval = options?.intervalMs ?? 400
    const deadline = options?.deadlineMs ?? 10_000
    const startedAt = Date.now()
    const capture = Effect.gen(function* () {
      const frame = yield* ui.capture()
      const [cursorX, cursorY] = frame.cursor
      return frame.lines.map((line, row) => {
        let text = line.spans.map((span) => span.text).join("")
        if (row === cursorY && cursorX < text.length)
          text = `${text.slice(0, cursorX)} ${text.slice(cursorX + 1)}`
        return text.trimEnd()
      })
    })
    const diff = (window: ReadonlyArray<ReadonlyArray<string>>) => {
      const unstable: Array<{ row: number; samples: Array<string> }> = []
      const rows = Math.max(...window.map((capture) => capture.length))
      for (let row = 0; row < rows; row++) {
        const texts = window.map((capture) => capture[row] ?? "")
        if (texts.some((text) => text !== texts[0]))
          unstable.push({ row, samples: texts })
      }
      return unstable
    }
    const window: Array<ReadonlyArray<string>> = [yield* capture]
    while (true) {
      yield* Effect.sleep(interval)
      window.push(yield* capture)
      if (window.length > samples) window.shift()
      const unstable = diff(window)
      if (window.length === samples && unstable.length === 0)
        return { stable: true as const, unstable, waitedMs: Date.now() - startedAt }
      if (Date.now() - startedAt >= deadline)
        return { stable: false as const, unstable, waitedMs: Date.now() - startedAt }
    }
  })

/** Parsed prompt-history entries from the instance's isolated home. */
export const promptHistory = (artifacts: string) =>
  Effect.promise(() =>
    Bun.file(`${artifacts}/home/.local/state/opencode/prompt-history.jsonl`)
      .text()
      .catch(() => ""),
  ).pipe(
    Effect.map((text) =>
      text
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as { text: string }]
          } catch {
            return []
          }
        }),
    ),
  )
