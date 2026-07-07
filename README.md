# opencode-drive

Drive visible, headless, simulated, or real OpenCode instances through a
publishable Bun CLI and TypeScript SDK.

```bash
bunx opencode-drive start --name demo

bunx opencode-drive send --name demo \
  --command.type "hello" \
  --command.press enter \
  --command.render \
  --command.state
```

`start` launches a detached headless simulated OpenCode process. Add
`--visible` to keep it in the foreground and show it in the terminal. Pass a custom OpenCode command after
`--`:

```bash
bunx opencode-drive start --name local --visible -- \
  opencode2 --standalone
```

Use `--dev` to run an OpenCode development checkout. The launcher installs the
checkout's `@opentui/solid` runtime in its isolated working directory and configures
Bun automatically:

```bash
bunx opencode-drive start --visible --dev ~/projects/opencode-latest
```

Both `start` and `send` accept `--driver ./driver.ts`. Drivers may default
export a function created with `defineDriver`:

```ts
import { defineDriver } from "opencode-drive/experimental"

export default defineDriver(async ({ ui }) => {
  await ui.typeText("hello")
  await ui.pressEnter()
  const state = await ui.state()
  if (!state.focused.editor) throw new Error("prompt editor is not focused")
})
```

Experimental campaign modules use `defineCampaign` from `opencode-drive/experimental`. Every case gets a fresh isolated,
headless OpenCode process. One deterministic case can use the same runner in a
visible terminal:

```bash
bunx opencode-drive start --campaign ./campaign.ts --seed 42000
bunx opencode-drive start --campaign ./campaign.ts --seed 42000 --case 17 --visible
```

OpenCode starts its drive interfaces when `OPENCODE_DRIVE` contains an instance
name and its simulated services when `OPENCODE_SIMULATE=1`. `run` creates the
named registry manifest, then sets both variables. OpenCode resolves the
manifest by name to obtain its drive ports. The manifest has this contract:

```json
{
  "version": 1,
  "name": "demo",
  "pid": 1234,
  "startedAt": "2026-07-06T00:00:00.000Z",
  "mode": "simulated",
  "cwd": "/workspace",
  "artifacts": "/tmp/opencode-drive/demo",
  "endpoints": {
    "ui": "ws://127.0.0.1:41000",
    "backend": "ws://127.0.0.1:41001"
  }
}
```

## Probe Experiments

Model-based and deterministic simulation drivers for the local opencode V2 TUI
and server. The probe controls the real application through simulation-only
WebSocket interfaces while external model and filesystem state remain isolated.

The opencode checkout is expected at `~/projects/opencode-latest`.

## Setup

```bash
cd ~/projects/opencode-drive
bun install
bun run check
```
