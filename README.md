# opencode-probe

Generates probe data against the latest local OpenCode checkout.

The `latest` symlink points at `~/projects/opencode-latest`, a checkout of `anomalyco/opencode`. Probe code imports source files from that checkout so generation tracks the current OpenCode tree.

```sh
bun install
bun run generate
bun run update:opencode
```
