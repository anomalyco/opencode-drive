---
"opencode-drive": patch
---

Move the pinned V2 SDK to `@opencode/client@0.0.0-dev-19699`. Current OpenCode V2 servers answer service discovery on `/api/status`; the previous `@opencode-ai/client` still probed `/api/health`, so Drive stopped a healthy script server with `OpenCode service registration was not found` before launching any TUI. Manual probes follow the same SDK: `server.status()` replaces `health.get()`, `session.form.*` replaces `form.*`, permission replies send `decision`, and plugin activation is polled through catalog reads.
