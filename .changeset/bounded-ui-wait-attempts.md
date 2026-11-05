---
"opencode-drive": patch
---

Retry `ui.waitFor`, `ui.getElement`, and `ui.getNode` polling attempts whose reply never arrives, so one RPC that OpenCode drops cannot consume the whole wait.
