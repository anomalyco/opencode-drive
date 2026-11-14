# OpenCode Drive

<a href="https://opencode.ai"><picture><source media="(prefers-color-scheme: dark)" srcset="https://opencode.ai/brand/badges/opencode-built-with-g-dark-20.svg"><img alt="Built with OpenCode" src="https://opencode.ai/brand/badges/opencode-built-with-g-light-20.svg" height="20" /></picture></a>
<a href="https://opencode.ai"><picture><source media="(prefers-color-scheme: dark)" srcset="https://opencode.ai/brand/badges/opencode-works-with-g-dark-20.svg"><img alt="Works with OpenCode" src="https://opencode.ai/brand/badges/opencode-works-with-g-light-20.svg" height="20" /></picture></a>

This monorepo contains the public `opencode-drive` package and its private OpenCode UI catalog.

- [`packages/drive`](packages/drive): drive isolated OpenCode instances and simulated LLMs.
- [`apps/catalog`](apps/catalog): capture and browse deterministic OpenCode UI flows.

```bash
bun install
bun run check
bun run test
bun run catalog
```

See [`packages/drive/README.md`](packages/drive/README.md) for package usage.
