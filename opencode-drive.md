# OpenCode Drive

## Purpose

`opencode-drive` is a separate developer tool for running simulated OpenCode instances and driving simulated or real instances.

OpenCode exposes two independent environment-controlled capabilities:

```sh
OPENCODE_SIMULATE=1  # simulated filesystem, network, and model services
OPENCODE_DRIVE=demo  # instance name used to resolve drive WebSocket ports
```

## Commands

The CLI has two commands:

```sh
opencode-drive start
opencode-drive send
```

### Run

`run` launches and owns a local OpenCode process with both environment variables enabled. It is headless and blocking by default; `--visible` shows it in the terminal.

```sh
opencode-drive start --name demo
opencode-drive start --name demo --visible --driver ./driver.ts
opencode-drive start --visible --dev ~/projects/opencode-latest
opencode-drive start --name demo \
  --command.type "hello" \
  --command.press enter
opencode-drive start --name demo -- opencode2 --standalone
```

When `--visible` is supplied, OpenCode remains visible while commands or a driver operate it. `run` cleans up when they finish, OpenCode exits, or the user interrupts it.

### Connect

`connect` targets an existing drive-enabled OpenCode instance and never owns or terminates it. The target may use simulated or real services.

```sh
opencode-drive send --name demo --command.render
opencode-drive send --name demo \
  --command.type "hello" \
  --command.press enter \
  --command.render
opencode-drive send --name demo --driver ./driver.ts
```

Each `--command.<operation>` flag represents one command. Scalar commands accept a scalar value, commands with structured input accept JSON, and commands without input are bare flags. Command flags may be repeated and execute sequentially over one WebSocket connection in argument order. The invocation prints an ordered JSON result and exits; the first failed command stops the batch and produces a nonzero exit status.

Commands are supported by both `run` and `connect`. Command flags, `--driver`, and `--campaign` are mutually exclusive execution modes.

## Names

`--name` identifies a running instance. `run` assigns the name and `connect` resolves it. If `run` omits the name, one is generated. If `connect` omits it, it uses `ws://127.0.0.1:40900` for the frontend and `ws://127.0.0.1:40950` for the backend.

## Drivers

Drivers use the TypeScript drive SDK and hold persistent WebSocket connections for ordered actions, asynchronous events, waits, assertions, and artifacts. `--driver` works with both `run` and `connect` but does not change process ownership.

## Campaigns

A campaign generates serializable flows and launches a fresh isolated, headless OpenCode process for each flow. Campaigns may use bounded parallelism and must save seeds, failures, artifacts, and replay commands.

```sh
# Run a campaign headlessly
opencode-drive start --campaign ./campaign.ts --seed 42000

# Generate and visibly replay one exact flow
opencode-drive start --campaign ./campaign.ts --seed 42000 --case 17 --visible
```

Visible replay uses the same generated flow, runner, and properties as the full campaign.

## Scope

There are no `start`, `drive`, profile, daemon, or stdio concepts. OpenCode communication uses WebSockets.
