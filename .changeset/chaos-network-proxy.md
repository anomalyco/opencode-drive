---
"opencode-drive": minor
---

Add a controllable chaos network proxy between launched TUIs and the OpenCode server, plus configurable simulated-LLM timeouts.

Enabling the new `network` option (on `defineScript`, driver options, and instance options) routes every launched TUI through a chaos TCP proxy: TUIs connect with an explicit `--server` pinned to the proxy and authenticate through the registered service password, so reconnects always cross the proxy, the TUI never elects a replacement server, and the drive control plane plus the driver's SDK client stay unaffected. Scripts and drivers control conditions through the new `network` capability: `set({ latencyMs, jitterMs, refuseNew, blackhole })` (replace-whole-state semantics), `clear()`, `killConnections()`, and `connections()`. The proxy resolves its upstream lazily from the service registration, so it follows server restarts that change ports.

The new `llm` option (`requestTimeout`, `settlementTimeout`) surfaces the existing LLM controller timeouts for scenarios that intentionally hold responses open longer than the 30s defaults.
