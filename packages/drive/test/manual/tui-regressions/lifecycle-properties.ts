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
  | {
      readonly phase: "idle"
      readonly sessionID?: SessionID
      readonly prompt?: string
      readonly output?: string
      readonly pendingPrompt?: string
    }
  | {
      readonly phase: "streaming"
      readonly sessionID: SessionID
      readonly prompt: string
      readonly output?: string
      readonly queuedPrompt?: string
    }

type SessionID = Effect.Success<
  ReturnType<OpenCode["session"]["list"]>
>["data"][number]["id"]

export default defineScript({
  run: ({ ui, llm, opencode, artifacts }) =>
    Effect.scoped(Effect.gen(function* () {
      const output = yield* Queue.unbounded<Llm.Output>()
      const responseEnded = yield* Queue.unbounded<void>()
      const eventQueue = yield* Queue.unbounded<RecordedEvent>()
      const events: Array<RecordedEvent> = []

      yield* llm.serve(() =>
        Stream.fromQueue(output).pipe(
          Stream.takeUntil((item) => item.type === "finish" || item.type === "disconnect"),
          Stream.ensuring(Queue.offer(responseEnded, undefined)),
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

      const endResponse = Effect.fn("LifecycleProperties.endResponse")(function* (
        item: Llm.Output,
      ) {
        yield* Queue.offer(output, item)
        yield* Queue.take(responseEnded)
      }, (effect) =>
        effect.pipe(
          Effect.timeoutOrElse({
            duration: 10_000,
            orElse: () => Effect.fail(new Error("timed out waiting for the LLM response to end")),
          }),
        ))

      const promptOwners = Effect.fn("LifecycleProperties.promptOwners")(function* (
        sessionID: SessionID,
        prompt: string,
      ) {
        const messages = yield* opencode.message.list({ sessionID, limit: 20, order: "desc" })
        const pending = yield* opencode.session.pending.list({ sessionID })
        return {
          projected: messages.data.filter(
            (message) => message.type === "user" && message.text === prompt,
          ).length,
          pending: pending.filter(
            (input) => input.type === "user" && input.data.text === prompt,
          ).length,
        }
      })

      const afterTerminal = Effect.fn("LifecycleProperties.afterTerminal")(function* (
        state: Extract<Model, { phase: "streaming" }>,
      ) {
        if (state.queuedPrompt === undefined)
          return {
            phase: "idle",
            sessionID: state.sessionID,
            prompt: state.prompt,
            output: state.output,
          } satisfies Model
        const owners = yield* promptOwners(state.sessionID, state.queuedPrompt)
        if (owners.pending === 1 && owners.projected === 0)
          return {
            phase: "idle",
            sessionID: state.sessionID,
            prompt: state.prompt,
            output: state.output,
            pendingPrompt: state.queuedPrompt,
          } satisfies Model
        if (owners.pending === 0 && owners.projected === 1) {
          yield* waitForEvent("session.execution.started", state.sessionID)
          return {
            phase: "streaming",
            sessionID: state.sessionID,
            prompt: state.queuedPrompt,
          } satisfies Model
        }
        return yield* Effect.fail(
          new Error(
            `queued prompt has ${owners.projected} projected and ${owners.pending} pending owners after terminal execution`,
          ),
        )
      })

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
            run: (state, step) =>
              Effect.gen(function* () {
                if (state.phase !== "idle") return state
                const prompt = `lifecycle-prompt-${step}`
                yield* ui.submit(prompt)
                if (state.pendingPrompt !== undefined)
                  yield* waitForEvent("session.input.admitted", state.sessionID)
                const started = yield* waitForEvent(
                  "session.execution.started",
                  state.sessionID,
                )
                const sessionID = yield* currentSession()
                if (started.sessionID !== sessionID)
                  return yield* Effect.fail(new Error("execution started for an unexpected session"))
                if (state.pendingPrompt !== undefined) {
                  yield* waitForEvent("session.input.promoted", sessionID)
                  yield* waitForEvent("session.input.promoted", sessionID)
                  const previous = yield* promptOwners(sessionID, state.pendingPrompt)
                  const current = yield* promptOwners(sessionID, prompt)
                  if (
                    previous.projected !== 1 ||
                    previous.pending !== 0 ||
                    current.projected !== 1 ||
                    current.pending !== 0
                  )
                    return yield* Effect.fail(
                      new Error(
                        `resumed prompts have previous ${previous.projected}/${previous.pending} and current ${current.projected}/${current.pending} projected/pending owners`,
                      ),
                    )
                  return { phase: "streaming", sessionID, prompt }
                }
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
            name: "queue-prompt",
            enabled: (state) => state.phase === "streaming" && state.queuedPrompt === undefined,
            run: (state, step) =>
              Effect.gen(function* () {
                if (state.phase !== "streaming") return state
                const queuedPrompt = `queued-prompt-${step}`
                yield* ui.submit(queuedPrompt)
                yield* waitForEvent("session.input.admitted", state.sessionID)
                return { ...state, queuedPrompt }
              }),
          },
          {
            name: "finish",
            enabled: (state) => state.phase === "streaming" && state.output !== undefined,
            run: (state) =>
              Effect.gen(function* () {
                if (state.phase !== "streaming") return state
                yield* endResponse(Llm.finish())
                if (state.queuedPrompt !== undefined) {
                  yield* waitForEvent("session.input.promoted", state.sessionID)
                  const owners = yield* promptOwners(state.sessionID, state.queuedPrompt)
                  if (owners.projected !== 1 || owners.pending !== 0)
                    return yield* Effect.fail(
                      new Error(
                        `promoted prompt has ${owners.projected} projected and ${owners.pending} pending owners`,
                      ),
                    )
                  return {
                    phase: "streaming",
                    sessionID: state.sessionID,
                    prompt: state.queuedPrompt,
                  }
                }
                yield* waitForEvent("session.execution.succeeded", state.sessionID)
                return yield* afterTerminal(state)
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
                yield* endResponse(Llm.text("discarded-after-interrupt", { delay: 0, chunkSize: 100 }))
                return yield* afterTerminal(state)
              }),
          },
          {
            name: "provider-disconnect",
            enabled: (state) => state.phase === "streaming",
            run: (state) =>
              Effect.gen(function* () {
                if (state.phase !== "streaming") return state
                yield* endResponse(Llm.disconnect())
                yield* waitForEvent("session.execution.failed", state.sessionID)
                return yield* afterTerminal(state)
              }),
          },
        ],
        invariants: [
          {
            name: "latest prompt remains visible",
            check: (state) =>
              state.phase === "streaming" && state.queuedPrompt !== undefined
                ? ui.waitFor(state.queuedPrompt, { timeout: 10_000 }).pipe(Effect.asVoid)
                : state.phase === "idle" && state.pendingPrompt !== undefined
                ? ui.waitFor(state.pendingPrompt, { timeout: 10_000 }).pipe(Effect.asVoid)
                : state.prompt === undefined
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
            name: "queued prompt has exactly one owner",
            check: (state) =>
              (state.phase === "streaming" ? state.queuedPrompt : state.pendingPrompt) === undefined ||
              state.sessionID === undefined
                ? Effect.void
                : Effect.gen(function* () {
                    const ownedPrompt = state.phase === "streaming" ? state.queuedPrompt : state.pendingPrompt
                    const sessionID = state.sessionID
                    if (ownedPrompt === undefined || sessionID === undefined) return
                    const owners = yield* promptOwners(sessionID, ownedPrompt)
                    if (owners.projected + owners.pending === 1) return
                    return yield* Effect.fail(
                      new Error(
                        `queued prompt has ${owners.projected} projected and ${owners.pending} pending owners: ${ownedPrompt}`,
                      ),
                    )
                  }),
          },
          {
            name: "settled session has no pending input",
            check: (state) =>
              state.phase !== "idle" || state.sessionID === undefined || state.pendingPrompt !== undefined
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
        yield* endResponse(Llm.text("discarded-during-cleanup", { delay: 0, chunkSize: 100 }))
        const settled = yield* afterTerminal(final)
        if (settled.phase === "streaming") {
          yield* opencode.session.interrupt({ sessionID: settled.sessionID })
          yield* waitForEvent("session.execution.interrupted", settled.sessionID)
          yield* endResponse(Llm.text("discarded-promoted-cleanup", { delay: 0, chunkSize: 100 }))
        }
      }
    })),
})

function readInteger(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error(`${name} must be an integer between 0 and ${maximum}`)
  return value
}
