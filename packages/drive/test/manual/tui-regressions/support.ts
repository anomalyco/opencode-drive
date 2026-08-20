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
