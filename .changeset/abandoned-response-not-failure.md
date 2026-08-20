---
"opencode-drive": patch
---

A served or queued LLM response whose backend detaches mid-stream (for example `server.kill()` while a reply is streaming) is now abandoned instead of recorded as a controller failure. Previously the interrupt-only cause poisoned the run with a phantom `LlmControllerError: All fibers interrupted without error`, making restart scenarios impossible to script.
