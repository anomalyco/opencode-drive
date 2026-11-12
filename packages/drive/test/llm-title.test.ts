import { describe, expect, test } from "vitest"
import { isTitleRequest } from "../src/llm/internal.js"

const currentSystem =
  "You name conversations so the user can find them later in a list of past sessions.\n\nYou will receive the first message of a conversation."

const firstMessage = (text: string) =>
  `Here is the first message of the conversation:\n\n<message>\n${text}\n</message>\n\nReply with only the title.`

const conversation = (text: string) =>
  `Here is the conversation so far:\n\n<conversation>\n${text}\n</conversation>\n\nReply with only the title.`

describe("isTitleRequest", () => {
  test("recognizes the current OpenCode title request", () => {
    expect(
      isTitleRequest({
        model: "gpt-sim-model",
        messages: [
          { role: "system", content: currentSystem },
          { role: "user", content: firstMessage("Say hi") },
        ],
      }),
    ).toBe(true)
  })

  test("recognizes current title prompts when the title agent system prompt is customized", () => {
    expect(
      isTitleRequest({
        messages: [
          { role: "system", content: "Prefer short titles." },
          { role: "user", content: [{ type: "text", text: firstMessage("Say hi") }] },
        ],
      }),
    ).toBe(true)
    expect(
      isTitleRequest({
        messages: [{ role: "user", content: conversation("Original request:\nSay hi") }],
      }),
    ).toBe(true)
  })

  test("keeps recognizing older title prompts", () => {
    expect(
      isTitleRequest({
        messages: [
          { role: "system", content: "You are a title generator. You output ONLY a thread title." },
          { role: "user", content: "Say hi" },
        ],
      }),
    ).toBe(true)
    expect(
      isTitleRequest({
        messages: [
          { role: "user", content: "Generate a title for this conversation:\n" },
          { role: "user", content: "Say hi" },
        ],
      }),
    ).toBe(true)
  })

  test("does not treat normal conversation turns as title requests", () => {
    expect(
      isTitleRequest({
        messages: [
          { role: "system", content: "You are an AI agent running in OpenCode." },
          { role: "user", content: "Say hi" },
        ],
      }),
    ).toBe(false)
    expect(
      isTitleRequest({
        messages: [
          { role: "system", content: "You are an AI agent running in OpenCode." },
          { role: "user", content: firstMessage("Say hi") },
          { role: "assistant", content: "Greeting" },
          { role: "user", content: firstMessage("Again") },
        ],
      }),
    ).toBe(false)
    expect(isTitleRequest({ input: "Say hi" })).toBe(false)
  })
})
