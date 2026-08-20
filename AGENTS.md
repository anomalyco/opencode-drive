## Protocol Convention

Keep CLI `--command.ui.*` names and parameter shapes identical to the frontend portion of the canonical OpenCode simulation protocol in `packages/drive/src/client/protocol.ts`. Backend LLM control belongs in scripts, not CLI commands. Do not add aliases or convenience methods; copy protocol updates from OpenCode and update the CLI directly.

`ui.screenshot` is the one deliberate Drive-local exception. OpenCode exposes `ui.capture`, which returns a renderer-neutral RGBA terminal frame. Drive implements `ui.screenshot` by calling `ui.capture`, rendering that frame to a PNG, and returning its absolute path. Do not add `ui.screenshot` to the OpenCode wire protocol, require an OpenCode endpoint to declare a media directory, or expose media-directory bookkeeping in normal usage. A standalone `--command.ui.screenshot` invocation must print the image path to stdout.

`packages/drive` is the generic published package. `apps/catalog` owns OpenCode-specific flow IDs, taxonomies, captures, and review UI; the package must not import the app.

## Writing Probe Scripts

Gotchas learned the hard way in `packages/drive/test/manual/`; prefer the helpers in `test/manual/tui-regressions/support.ts` over reimplementing them.

- Timeout severity is split: `UiWaitTimeoutError` (a `waitFor`/`getElement`/`getNode` deadline passed) is catchable and safe to branch on; `UiTimeoutError` (an unanswered UI RPC) aborts the whole run even when caught. Use `support.appeared` for "did X show up in time?".
- LLM request bodies carry the whole conversation. Route markers by which appears **last** in the serialized body (`lastIndexOf`), never by the first `includes` hit (`support.serveMarkers`).
- Server admissions are the only ground truth for "did my prompt land" (`support.admissions`). The screen and `prompt-history.jsonl` can both mislead: history records composer text at POST-resolution time, which may include text typed mid-flight that was never sent.
- `ctrl+c` on an empty composer exits the TUI (killing the run with `RpcClientDefect: connection closed`); use `ctrl+u` to clear leftover composer text.
- Effect v4: it is `Effect.catch`, not `Effect.catchAll`.
- Seeded state-machine probes stream every chosen transition to stderr and must write `state-machine-failure.json` on any failure, including terminal verify phases (`state-machine.ts` exports `saveFailure`). A failure without its seed and trace is nearly worthless.
- Isolated-instance state lives under `${artifacts}/home/...` (for example `home/.local/state/opencode/prompt-history.jsonl`); screenshots land under the run's `output/.../generation-N/` directory.
- Set `OPENCODE_DRIVE_MEDIA_DIR=$PWD/.drive-output` (gitignored) when running probes from an agent. The default media root is under the system tmpdir with a per-run id in the path, so every run triggers a fresh outside-the-project permission prompt; a stable in-workspace directory avoids that entirely.
- Interrupting a busy session takes **two** escape presses within 5 seconds (the first arms, the second fires `session.interrupt`). A single `ui.press("escape")` is a no-op for interruption.
- `server.kill()` mid-stream abandons the in-flight served reply (deliberate detach, not a failure) and `server.launch()` attaches the LLM stub to the replacement service; pass `OPENCODE_DRIVE_DB=...` so both generations share a database (see `quiescence-restart.ts`).
