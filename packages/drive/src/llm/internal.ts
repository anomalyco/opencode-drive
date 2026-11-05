const titleSystemPrefixes = [
  "You name conversations so the user can find them later",
  "You are a title generator.",
]

const titleUserPrefixes = [
  "Here is the first message of the conversation:",
  "Here is the conversation so far:",
]

export function isTitleRequest(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.messages)) return false
  const messages = body.messages.filter(isMessageObject)
  const first = messages[0]
  if (
    first?.role === "user" &&
    messageContent(first)?.startsWith("Generate a title for this conversation:")
  )
    return true
  const system = messageContent(
    messages.find((message) => message.role === "system"),
  )
  if (titleSystemPrefixes.some((prefix) => system?.startsWith(prefix)))
    return true
  const users = messages.filter((message) => message.role === "user")
  const content = users.length === 1 ? messageContent(users[0]) : undefined
  return (
    content !== undefined &&
    titleUserPrefixes.some((prefix) => content.startsWith(prefix)) &&
    content.trimEnd().endsWith("Reply with only the title.")
  )
}

export function* chunkText(text: string, chunkSize: number) {
  const characters = Array.from(text)
  for (let index = 0; index < characters.length; ) {
    const size = Math.max(
      1,
      chunkSize + Math.floor(Math.random() * 11) - 5,
    )
    const end = Math.min(characters.length, index + size)
    yield characters.slice(index, end).join("")
    index = end
  }
}

function isMessageObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> & { readonly role: string } {
  return isRecord(value) && typeof value.role === "string"
}

function messageContent(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined
  const content = message.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (isRecord(part) && typeof part.text === "string") return part.text
      return ""
    })
    .join("")
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
