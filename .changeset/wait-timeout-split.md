---
"opencode-drive": minor
---

Split wait deadlines from control-plane timeouts. `ui.waitFor`, `ui.getElement`, and `ui.getNode` now fail with the new catchable `UiWaitTimeoutError` when their deadline passes, so scripts can branch on "did X appear in time?" (for example with `Effect.catchTag("UiWaitTimeoutError", ...)`). `UiTimeoutError` is reserved for unanswered UI RPCs — an unresponsive control plane — and remains fatal to script runs even when caught.
