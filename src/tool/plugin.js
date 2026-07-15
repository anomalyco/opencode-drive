const output = (result) => ({
  structured: {
    exit: result.exit ?? 0,
    ...(result.shellID === undefined ? {} : { shellID: result.shellID }),
    truncated: result.truncated ?? false,
    ...(result.timeout === undefined ? {} : { timeout: result.timeout }),
  },
  content: [{ type: "text", text: result.output }],
})

const MAX_BUFFER_CHARS = 1024 * 1024

async function execute(options, name, input, context) {
  const response = await fetch(`${options.endpoint}/execute/${name}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  })
  if (!response.ok || !response.body)
    throw new Error(`Drive tool handler returned HTTP ${response.status}`)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let result
  let complete = false
  try {
    while (true) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value, { stream: !chunk.done })
      if (buffer.length > MAX_BUFFER_CHARS)
        throw new Error(`Drive tool event exceeds ${MAX_BUFFER_CHARS} characters`)
      let newline
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const event = JSON.parse(line)
        if (event.type === "progress") await context.progress(output(event.result))
        if (event.type === "success") result = event.result
        if (event.type === "failure") throw new Error(event.message)
      }
      if (chunk.done) break
    }
    if (!result) throw new Error("Drive tool handler ended without a result")
    complete = true
    return output(result)
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export default {
  id: "opencode-drive.tool-handlers",
  async setup(ctx) {
    const options = ctx.options
    await ctx.tool.transform((tools) => {
      if (!options.tools.includes("shell")) return
      tools.add({
        name: "shell",
        description: "Executes a shell command.",
        jsonSchema: options.schemas.shell,
        options: { codemode: false },
        execute: (input, context) => execute(options, "shell", input, context),
      })
    })
  },
}
