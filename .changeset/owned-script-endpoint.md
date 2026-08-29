---
"opencode-drive": patch
---

Pin scripted TUIs to the script-owned server and retain its HTTP endpoint across restarts, preventing TUI reconnects from electing a competing managed service. Existing SDK clients also remain connected to the replacement server; network-chaos TUIs continue to use the proxy.
