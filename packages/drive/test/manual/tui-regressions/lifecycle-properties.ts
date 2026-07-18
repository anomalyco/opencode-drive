import { defineScript, Llm } from "../../../src/index.js"
import type { OpenCode } from "../../../src/index.js"
import { Effect, Queue, Stream } from "effect"
import { run } from "./state-machine.js"

const seed = readInteger("OPENCODE_DRIVE_SEED", 1, Number.MAX_SAFE_INTEGER)
const steps = readInteger("OPENCODE_DRIVE_STEPS", 12, 1_000)

interface RecordedEvent {
  readonly type: string
  readonly sessionID?: unknown
  readonly data: unknown
}

type Model =
  | { readonly phase: "idle"; readonly sessionID?: SessionID; readonly prompt?: string; readonly output?: string }
  | {
      readonly phase: "streaming"
      readonly sessionID: SessionID
      readonly prompt: string
      readonly output?: string
    }

type SessionID = Effect.Success<
  ReturnType<OpenCode["session"]["list"]>
>["data"][number]["id"]

export default defineScript({
  run: ({ ui, llm, opencode, artifacts }) =>
    Effect.scoped(Effect.gen(function* () {
      const output = yield* Queue.unbounded<Llm.Output>()
      const eventQueue = yield* Queue.unbounded<RecordedEvent>()
      const events: Array<RecordedEvent> = []

      yield* llm.serve(() =>
        Stream.fromQueue(output).pipe(
          Stream.takeUntil((item) => item.type === "finish" || item.type === "disconnect"),
        ),
      )
      yield* opencode.event.subscribe().pipe(
        Stream.runForEach((event) => {
          const recorded: RecordedEvent = {
            type: event.type,
            ...(event.data !== null &&
            typeof event.data === "object" &&
            "sessionID" in event.data
              ? { sessionID: event.data.sessionID }
              : {}),
            data: event.data,
          }
          events.push(recorded)
          if (events.length > 100) events.shift()
          return Queue.offer(eventQueue, recorded).pipe(Effect.asVoid)
        }),
        Effect.forkScoped,
      )

      const currentSession = Effect.fn("LifecycleProperties.currentSession")(function* () {
        const sessions = yield* opencode.session.list({ limit: 1, order: "desc" })
        const sessionID = sessions.data[0]?.id
        if (sessionID === undefined) return yield* Effect.fail(new Error("no current session"))
        return sessionID
      })

      const waitForEvent = Effect.fn("LifecycleProperties.waitForEvent")(function* (
        type: string,
        sessionID: SessionID | undefined,
      ) {
        while (true) {
          const event = yield* Queue.take(eventQueue)
          if (event.type === type && (sessionID === undefined || event.sessionID === sessionID)) return event
        }
      }, (effect, type) =>
        effect.pipe(
          Effect.timeoutOrElse({
            duration: 10_000,
            orElse: () => Effect.fail(new Error(`timed out waiting for ${type}`)),
          }),
        ))

      const final = yield* run<Model>({
        context: {
          ui,
          artifacts,
          evidence: () => Effect.succeed({ events }),
        },
        initial: { phase: "idle" },
        seed,
        steps,
        transitions: [
          {
            name: "submit",
            enabled: (state) => state.phase === "idle",
            run: (_, step) =>
              Effect.gen(function* () {
                const prompt = `lifecycle-prompt-${step}`
                yield* ui.submit(prompt)
                const started = yield* waitForEvent("session.execution.started", undefined)
                const sessionID = yield* currentSession()
                if (started.sessionID !== sessionID)
                  return yield* Effect.fail(new Error("execution started for an unexpected session"))
                return { phase: "streaming", sessionID, prompt }
              }),
          },
          {
            name: "emit-text",
            enabled: (state) => state.phase === "streaming" && state.output === undefined,
            run: (state, step) =>
              Effect.gen(function* () {
                if (state.phase !== "streaming") return state
                const text = `lifecycle-output-${step}`
                yield* Queue.offer(output, Llm.text(text, { delay: 0, chunkSize: 100 }))
                yield* waitForEvent("session.text.started", state.sessionID)
                return { ...state, output: text }
              }),
          },
          {
            name: "finish",
            enabled: (state) => state.phase === "streaming" && state.output !== undefined,
            run: (state) =>
              Effect.gen(function* () {
                if (state.phase !== "streaming") return state
                yield* Queue.offer(output, Llm.finish())
                yield* waitForEvent("session.execution.succeeded", state.sessionID)
                return { phase: "idle", sessionID: state.sessionID, prompt: state.prompt, output: state.output }
              }),
          },
          {
            name: "interrupt",
            enabled: (state) => state.phase === "streaming",
            run: (state) =>
              Effect.gen(function* () {
                if (state.phase !== "streaming") return state
                yield* opencode.session.interrupt({ sessionID: state.sessionID })
                yield* waitForEvent("session.execution.interrupted", state.sessionID)
                yield* Queue.offer(output, Llm.text("discarded-after-interrupt", { delay: 0, chunkSize: 100 }))
                return { phase: "idle", sessionID: state.sessionID, prompt: state.prompt, output: state.output }
              }),
          },
          {
            name: "provider-disconnect",
            enabled: (state) => state.phase === "streaming",
            run: (state) =>
              Effect.gen(function* () {
                if (state.phase !== "streaming") return state
                yield* Queue.offer(output, Llm.disconnect())
                yield* waitForEvent("session.execution.failed", state.sessionID)
                return { phase: "idle", sessionID: state.sessionID, prompt: state.prompt, output: state.output }
              }),
          },
        ],
        invariants: [
          {
            name: "latest prompt remains visible",
            check: (state) =>
              state.prompt === undefined
                ? Effect.void
                : ui.waitFor(state.prompt, { timeout: 10_000 }).pipe(Effect.asVoid),
          },
          {
            name: "settled output remains visible",
            check: (state) =>
              state.phase !== "idle" || state.output === undefined
                ? Effect.void
                : ui.waitFor(state.output, { timeout: 10_000 }).pipe(Effect.asVoid),
          },
          {
            name: "settled composer is actionable",
            check: (state) =>
              state.phase === "idle"
                ? ui.waitFor((current) => current.focused.editor, { timeout: 10_000 }).pipe(Effect.asVoid)
                : Effect.void,
          },
          {
            name: "server projection retains the latest prompt",
            check: (state) =>
              state.sessionID === undefined || state.prompt === undefined
                ? Effect.void
                : Effect.gen(function* () {
                    const sessionID = state.sessionID
                    const prompt = state.prompt
                    if (sessionID === undefined || prompt === undefined) return
                    const messages = yield* opencode.message.list({
                      sessionID,
                      limit: 20,
                      order: "desc",
                    })
                    if (messages.data.some((message) => message.type === "user" && message.text === prompt))
                      return
                    return yield* Effect.fail(new Error(`server projection lost prompt: ${prompt}`))
                  }),
          },
          {
            name: "settled session has no pending input",
            check: (state) =>
              state.phase !== "idle" || state.sessionID === undefined
                ? Effect.void
                : Effect.gen(function* () {
                    const sessionID = state.sessionID
                    if (sessionID === undefined) return
                    const pending = yield* opencode.session.pending.list({ sessionID })
                    if (pending.length === 0) return
                    return yield* Effect.fail(new Error(`settled session retained ${pending.length} pending input(s)`))
                  }),
          },
          {
            name: "transport defects are not rendered",
            check: () =>
              Effect.forEach(["UnknownError", "RpcClientDefect"], (text) =>
                ui.matches(text).pipe(
                  Effect.filterOrFail((visible) => !visible, () => new Error(`rendered internal error: ${text}`)),
                ),
              ).pipe(Effect.asVoid),
          },
        ],
      })

      if (final.phase === "streaming") {
        yield* opencode.session.interrupt({ sessionID: final.sessionID })
        yield* waitForEvent("session.execution.interrupted", final.sessionID)
        yield* Queue.offer(output, Llm.text("discarded-during-cleanup", { delay: 0, chunkSize: 100 }))
      }
    })),
})

function readInteger(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error(`${name} must be an integer between 0 and ${maximum}`)
  return value
}
