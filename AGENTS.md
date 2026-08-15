## Protocol Convention

Keep CLI `--command.ui.*` names and parameter shapes identical to the frontend portion of the canonical OpenCode simulation protocol in `packages/drive/src/client/protocol.ts`. Backend LLM control belongs in scripts, not CLI commands. Do not add aliases or convenience methods; copy protocol updates from OpenCode and update the CLI directly.

`ui.screenshot` is the one deliberate Drive-local exception. OpenCode exposes `ui.capture`, which returns a renderer-neutral RGBA terminal frame. Drive implements `ui.screenshot` by calling `ui.capture`, rendering that frame to a PNG, and returning its absolute path. Do not add `ui.screenshot` to the OpenCode wire protocol, require an OpenCode endpoint to declare a media directory, or expose media-directory bookkeeping in normal usage. A standalone `--command.ui.screenshot` invocation must print the image path to stdout.

`packages/drive` is the generic published package. `apps/catalog` owns OpenCode-specific flow IDs, taxonomies, captures, and review UI; the package must not import the app.
