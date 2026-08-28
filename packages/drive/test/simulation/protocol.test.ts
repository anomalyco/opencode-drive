import { expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { Backend, Handshake, JsonRpc } from "../../src/simulation/protocol.js"

it("decodes the canonical dynamic tool lifecycle", () => {
  expect(
    Backend.decodeRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tool.attach",
      params: {
        tools: [
          {
            name: "search",
            description: "Search GitHub",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            permission: "search",
            options: { namespace: "github.api", codemode: false },
          },
        ],
      },
    }),
  ).toMatchObject({ method: "tool.attach" })
  expect(
    Backend.decodeRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tool.update",
      params: {
        id: "tool_1",
        sequence: 0,
        update: {
          phase: "searching",
          output: "Searching",
        },
      },
    }),
  ).toMatchObject({ method: "tool.update" })
})

it("requires exactly one JSON-RPC result or error", () => {
  const decode = Schema.decodeUnknownSync(JsonRpc.Response)
  const response = { jsonrpc: "2.0", id: 1 }
  const error = { code: -32000, message: "failed" }
  expect(decode({ ...response, result: null })).toEqual({ ...response, result: null })
  expect(decode({ ...response, error })).toEqual({ ...response, error })
  expect(() => decode(response)).toThrow()
  expect(() => decode({ ...response, result: null, error })).toThrow()
})

it("rejects duplicated negotiated capabilities", () => {
  expect(() => Schema.decodeUnknownSync(Handshake.Response)({
    protocolVersion: 1,
    role: "backend",
    server: { name: "OpenCode", version: "test" },
    capabilities: ["llm.attach", "llm.attach"],
  })).toThrow()
})

it("rejects unsafe, colliding, and reserved exposed names", () => {
  const attach = (tools: ReadonlyArray<unknown>) =>
    Backend.decodeRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tool.attach",
      params: { tools },
    })
  const tool = {
    name: "search",
    description: "Search",
    inputSchema: { type: "object" },
  }

  expect(() => attach([{ ...tool, name: "unsafe.name" }])).toThrow()
  expect(() =>
    attach([
      { ...tool, options: { namespace: "a.b" } },
      { ...tool, options: { namespace: "a_b" } },
    ]),
  ).toThrow()
  expect(() =>
    attach([
      {
        ...tool,
        name: "execute",
        options: { codemode: false },
      },
    ]),
  ).toThrow()
})

it("decodes provider-neutral partial tool input chunks", () => {
  expect(
    Backend.Item.make({
      type: "toolInputStart",
      index: 0,
      id: "call_lookup",
      name: "lookup",
    }),
  ).toEqual({
    type: "toolInputStart",
    index: 0,
    id: "call_lookup",
    name: "lookup",
  })
  expect(
    Backend.Item.make({
      type: "toolInputDelta",
      index: 0,
      text: '{"query":"meaning"}',
    }),
  ).toEqual({
    type: "toolInputDelta",
    index: 0,
    text: '{"query":"meaning"}',
  })
})
