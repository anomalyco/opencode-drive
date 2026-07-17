---
"opencode-drive": minor
---

Unify the Effect driver and `defineScript` around one canonical programmatic model. Script clients now use the same `Client`, `Ui`, and `{ recording, viewport }` options as library drivers, expose terminal frame capture through `client.ui.capture()`, and close with `client.close()`. Project setup now uses the shared `Project`, `Setup`, `SetupContext`, and `ProjectFileSystem` types. Remove duplicate script UI types, flattened script clients, partial settlement controls, root-level raw simulation exports, convenience CLI aliases, and the `wait` helper.
