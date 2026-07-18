---
"opencode-drive": major
---

Remove the Promise-based simulation clients. `SimulationClient`, `BackendSimulationClient`, `connectSimulation`, and `connectBackendSimulation` are gone, along with the `opencode-drive/experimental` entry point. The `opencode-drive/client` entry now exports only the canonical protocol schemas and default ports; the public API is Effect-only, as documented. The CLI drives instances through the Effect `SimulationConnector` directly.
