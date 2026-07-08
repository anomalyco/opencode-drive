---
name: opencode-drive
description: Use when an agent needs to debug and drive an OpenCode TUI instance
---

# OpenCode Drive

Use `opencode-drive` to launch an isolated OpenCode instance and control its TUI through WebSocket commands.

## Basic Flow

- Always give the instance a unique `--name`.
- A normal headless `start` detaches automatically and returns after the instance is ready.
- Do not add `&`; the long-running owner already runs in the background.
- Configure simulated model responses after startup when needed.
- Send ordered UI commands with `send`.
- Always stop the instance when finished.

```bash
opencode-drive start --name demo

opencode-drive send --name demo \
  --command.ui.type '{"text":"Explain this project"}' \
  --command.ui.enter

opencode-drive stop --name demo
```

## Configure Responses

- `responses` changes its behavior while the instance is running.
- `--types` is a comma-delimited set selected randomly for each new model response.
- Supported types are `text`, `reasoning`, `diff`, and `tool`.
- `--tools` limits generated tool calls to names offered by OpenCode.
- Defaults are `text,reasoning,diff,tool` with `write,apply_patch`.
- Running `responses` without flags prints the active configuration.

```bash
opencode-drive responses --name demo \
  --types text,reasoning,diff,tool \
  --tools write,apply_patch

opencode-drive responses --name demo \
  --types tool \
  --tools read,glob,grep
```

## Send UI Commands

- Every `send` opens a connection to the named instance, runs its commands in order, and exits.
- Combine typing and Enter in one command when submitting a prompt.
- JSON-valued commands require one JSON argument.
- Multiple command flags execute from left to right.

Commands:

- `--command.ui.type <json>` types into the focused editor. Arguments: `text` string.
- `--command.ui.press <json>` presses a key. Arguments: `key` string; optional `modifiers` object with boolean `ctrl`, `shift`, `meta`, `super`, or `hyper`.
- `--command.ui.enter` presses Enter. Arguments: none.
- `--command.ui.arrow <json>` presses an arrow key. Arguments: `direction` is `up`, `down`, `left`, or `right`.
- `--command.ui.focus <json>` focuses an element. Arguments: `target` is the numeric element `num` returned by `ui.state`.
- `--command.ui.click <json>` clicks an element. Arguments: numeric `target`, `x`, and `y`; use the element `num` returned by `ui.state` as `target`.
- `--command.ui.state` prints focus and interactive element metadata as JSON. Arguments: none.

```bash
opencode-drive send --name demo \
  --command.ui.type '{"text":"Find the relevant code and explain it"}' \
  --command.ui.enter

opencode-drive send --name demo \
  --command.ui.press '{"key":"p","modifiers":{"ctrl":true}}'

opencode-drive send --name demo \
  --command.ui.arrow '{"direction":"down"}'

opencode-drive send --name demo \
  --command.ui.focus '{"target":12}'

opencode-drive send --name demo \
  --command.ui.click '{"target":12,"x":4,"y":1}'
```

To read the UI state and see information about interactable elements, use the `ui.state` command:

```bash
opencode-drive send --name demo --command.ui.state
```

## Inspect The UI

- `ui.state` prints focus and interactive element metadata as JSON.
- `screenshot` prints the generated image path.

```bash
opencode-drive screenshot --name demo
```

## Record The UI

- `record-end` prints the recording path.

```bash
opencode-drive record-start --name demo

opencode-drive send --name demo \
  --command.ui.type '{"text":"Show me the current architecture"}' \
  --command.ui.enter

opencode-drive record-end --name demo
```

## Logs

- `logs` prints the OpenCode log file for the instance

```bash
opencode-drive logs --name demo
```

## Lifecycle

- `stop` waits for owner cleanup before returning success.

```bash
opencode-drive stop --name demo
```
