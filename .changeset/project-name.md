---
"opencode-drive": minor
---

Add `project.name` to name the isolated project directory, expose it as `directory` on drivers and script contexts, and create artifacts under the real temp path so OpenCode shows the project as `~/<name>` instead of a truncated `/…/run-*/files` path on macOS.
