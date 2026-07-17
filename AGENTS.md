## Protocol Convention

Keep CLI `--command.ui.*` names and parameter shapes identical to the frontend portion of the canonical OpenCode simulation protocol in `packages/drive/src/client/protocol.ts`. Backend LLM control belongs in scripts, not CLI commands. Do not add aliases or convenience methods; copy protocol updates from OpenCode and update the CLI directly.

`packages/drive` is the generic published package. `apps/catalog` owns OpenCode-specific flow IDs, taxonomies, captures, and review UI; the package must not import the app.
