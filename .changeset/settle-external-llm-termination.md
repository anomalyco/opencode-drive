---
"opencode-drive": patch
---

Settle simulated LLM responses cleanly when OpenCode terminates an invocation during interruption. Drive now uses the negotiated `llm.pending` capability to distinguish external termination from genuine response write failures.
