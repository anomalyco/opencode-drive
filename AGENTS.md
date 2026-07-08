## Protocol Convention

Keep CLI `--command.ui.*` names and parameter shapes identical to the frontend portion of the canonical OpenCode simulation protocol in `src/client/protocol.ts`. Backend LLM control belongs in scripts, not CLI commands. Do not add aliases or convenience methods; copy protocol updates from OpenCode and update the CLI directly.
