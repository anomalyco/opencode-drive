# OpenCode Terminal Catalog

Production: <https://catalog.kitlangton.dev>

Capture a reproducible catalog of OpenCode terminal states from local checkouts, browse every state in one web app, and flip between themes or branches without changing the selected screen.

The catalog currently contains 23 scripted states covering the home screen, command and model pickers, integrations, themes, MCPs, permissions, questions, sessions, subagents, shell output, toasts, and the diff viewer.

## Prerequisites

- [Bun](https://bun.sh/) 1.3 or newer.
- A current local OpenCode v2 checkout with dependencies installed.

## Install

```bash
gh repo clone anomalyco/opencode-catalog
cd opencode-catalog
bun install
```

The OpenCode checkout can live anywhere. Capture commands receive its path explicitly; no sibling-directory layout is required.

## Capture One Checkout

```bash
bun run capture -- \
  --variant baseline=$HOME/code/opencode

bun run generate
bun run dev
```

Open the URL printed by `bun run dev`.

`baseline` is the variant ID shown in the catalog. Variant IDs must be lowercase slugs such as `baseline`, `rosepine`, or `theme-redesign`.

## Compare Themes

Variants can use the same OpenCode checkout with different configured themes:

```bash
bun run capture -- \
  --variant opencode=$HOME/code/opencode \
  --theme opencode=opencode \
  --variant rosepine=$HOME/code/opencode \
  --theme rosepine=rosepine

bun run generate
bun run dev
```

`--theme` uses `variant-id=theme-name`, so each theme is attached to one declared variant. Built-in names include `opencode`, `nord`, `one-dark`, `gruvbox`, `rosepine`, `solarized`, `monokai`, and `palenight`.

In the catalog:

- In the viewer, press left or right to move through flow steps and up or down to switch variants.
- Use **Copy ID** to copy the active flow state address, or the capture ID when browsing screens directly.

Reproduce a registered executable state against an OpenCode checkout:

```bash
bun run reproduce -- patch-success-lifecycle/permission-prompt \
  --opencode /path/to/opencode
```

The command prints the path to a normalized terminal frame. Only states from flows registered in `scenarios/index.ts` are currently reproducible; other catalog flows remain browse-only until their recipes are migrated.
- Click a card to open its full-screen viewer.
- Press up or down in the viewer to move between screens.
- Press `Escape` to close the viewer.
- Press `Cmd+K` or `Ctrl+K` to search screens, labels, UI elements, and flows.

## Compare Branches

Create two OpenCode worktrees or clones, then capture both:

```bash
bun run capture -- \
  --variant before=$HOME/code/opencode-main \
  --variant after=$HOME/code/opencode-redesign

bun run generate
bun run dev
```

Themes and checkout comparisons can be combined:

```bash
bun run capture -- \
  --variant main-nord=$HOME/code/opencode-main \
  --theme main-nord=nord \
  --variant redesign-nord=$HOME/code/opencode-redesign \
  --theme redesign-nord=nord
```

Each variant runs in an isolated OpenCode Drive instance. Independent variants capture concurrently, while the states inside one variant remain sequential so session-dependent states stay deterministic.

## Agent Workflow

An agent can operate the full workflow using ordinary shell commands. Give it the catalog repository path, the OpenCode checkout paths, and the variants you want.

Example request:

```text
Capture the OpenCode terminal catalog with these variants:

- baseline: ~/code/opencode-main using the opencode theme
- redesign: ~/code/opencode-redesign using the rosepine theme

Run generation, typecheck, tests, and the production build. Start the local
catalog and verify that left/right moves through flow steps while up/down changes variants.
Do not hand-edit generated frame files.
```

The equivalent commands are:

```bash
bun install
bun run capture -- \
  --variant baseline=$HOME/code/opencode-main \
  --theme baseline=opencode \
  --variant redesign=$HOME/code/opencode-redesign \
  --theme redesign=rosepine
bun run generate
bun run typecheck
bun run test
bun run build
bun run dev
```

Repository-specific architecture and editing rules for agents are in [`AGENTS.md`](./AGENTS.md).

## Generated Artifacts

Capture writes:

```text
public/drive-captures.json
public/captures/<variant>/<screen>.frame.json
```

Generation reads those files and writes:

```text
public/catalog.json
```

Raw terminal frames are authoritative. They preserve text spans, cell widths, resolved RGBA colors, text attributes, cursor position, and terminal dimensions. The browser derives canvas pixels from those frames with Commit Mono. PNG and SVG renderers can be added later without recapturing states.

Do not edit generated frame or manifest files manually. Change the capture scenario or authored catalog metadata and regenerate them.

## Catalog Metadata

Human-authored classification lives in:

```text
catalog/authored/taxonomies.ts
catalog/authored/screens.ts
catalog/authored/flows.ts
```

These files control titles, labels, UI elements, facets, and flow membership independently of terminal capture data.

## Validation

Run the complete local validation:

```bash
bun run generate
bun run typecheck
bun run test
bun run build
```

Generation validates every frame's schema, viewport, row count, and cell width before producing `catalog.json`.

## Deploy

The application deploys as a Cloudflare Worker with static assets:

```bash
bun run deploy
```

Current deployment: https://opencode-terminal-catalog.kit-langton.workers.dev

## Troubleshooting

### `ui.capture` is unknown

The target OpenCode checkout predates the simulation protocol change. Fetch and update to the current `v2` branch, which includes [PR #37135](https://github.com/anomalyco/opencode/pull/37135).

### Capture times out waiting for text

OpenCode UI copy changed. Read the current v2 TUI source, update the exact wait marker in `scripts/capture-opencode-drive.ts`, and rerun the whole capture. Do not weaken waits with arbitrary sleeps.

### A theme does not appear

Confirm the theme name in OpenCode's `/themes` picker. Theme names are passed directly to OpenCode configuration.

### The browser shows stale assets

Restart `bun run dev` after changing dependencies, then reload the page. Production builds always start from a clean `dist/` directory.
