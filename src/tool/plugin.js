import { Effect, Schema } from "effect"

const MAX_BUFFER_CHARS = 1024 * 1024
const descriptions = {
  shell: "Executes a shell command.",
  webfetch: "Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML.",
  websearch: "Search the web using the session's local web search provider.",
}

class ToolFailure extends Schema.TaggedErrorClass()("LLM.ToolFailure", {
  message: Schema.String,
}) {}

const output = (result) => ({
  structured: result,
  content: [{ type: "text", text: result.output }],
})

const failure = (cause) =>
  cause instanceof ToolFailure
    ? cause
    : new ToolFailure({ message: cause instanceof Error ? cause.message : String(cause) })

const parse = (line) =>
  Effect.try({
    try: () => JSON.parse(line),
    catch: (cause) => failure(cause),
  })

const execute = (options, name, input, context) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${options.endpoint}/execute/${name}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
          signal,
        }),
      catch: failure,
    })
    if (!response.ok || !response.body)
      return yield* new ToolFailure({ message: `Drive tool handler returned HTTP ${response.status}` })

    const reader = response.body.getReader()
    return yield* Effect.acquireUseRelease(
      Effect.succeed(reader),
      (reader) =>
        Effect.gen(function* () {
          const decoder = new TextDecoder()
          let buffer = ""
          let result
          while (true) {
            const chunk = yield* Effect.tryPromise({
              try: () => reader.read(),
              catch: failure,
            })
            buffer += decoder.decode(chunk.value, { stream: !chunk.done })
            if (buffer.length > MAX_BUFFER_CHARS)
              return yield* new ToolFailure({
                message: `Drive tool event exceeds ${MAX_BUFFER_CHARS} characters`,
              })
            let newline
            while ((newline = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, newline)
              buffer = buffer.slice(newline + 1)
              if (!line) continue
              const event = yield* parse(line)
              if (event.type === "progress") yield* context.progress(output(event.result))
              if (event.type === "success") result = event.result
              if (event.type === "failure")
                return yield* new ToolFailure({ message: event.message })
            }
            if (chunk.done) break
          }
          if (!result)
            return yield* new ToolFailure({ message: "Drive tool handler ended without a result" })
          return output(result)
        }),
      (reader) => Effect.promise(() => reader.cancel().catch(() => undefined)),
    )
  })

export default {
  id: "opencode-drive.tool-handlers",
  effect: (ctx) =>
    ctx.tool.transform((tools) => {
      for (const name of ctx.options.tools) {
        tools.add(
          name,
          {
            description: descriptions[name],
            jsonSchema: ctx.options.schemas[name],
            execute: (input, context) => execute(ctx.options, name, input, context),
          },
          { codemode: false },
        )
      }
    }),
}
