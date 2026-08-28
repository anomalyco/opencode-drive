---
"opencode-drive": major
---

Update Drive to the current OpenCode V2 client (`0.0.0-dev-18535`) and its
matching Effect V4 stack (`4.0.0-rc.112`). Effect is now an exact peer dependency
so consumer programs and Drive share the same Effect types and runtime.
The client, protocol, schema, platform, and test packages use the same
coherent `rc.112` stack.

Migrate schema-backed errors and RPC JSON codecs, and preserve optional CLI
boolean flags with explicit false defaults. Static tool adapters now emit
native V2 progress metadata, result metadata, and `Tool.Error` failures.

Dynamic tool controls follow the current V2 protocol: change
`invocation.progress({ structured: { phase: "searching" } })` to
`invocation.progress({ phase: "searching" })`, and read the model call ID from
`invocation.context.id` instead of `invocation.context.callID`.
`finish({ structured, content })` and LLM queue/send/serve/title sequencing,
cancellation, reconnection, supervision, and settlement retain their contracts.
