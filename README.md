# opencode-drive

This project gives your agents control over OpenCode:

* Run it during development and let your agents see and poke at the running instance
* Allow your agents to run it in headless mode and drive it to test things

## Skill

```sh
npx skills add jlongster/opencode-drive --agent opencode --skill opencode-drive
```
## OpenCode development

Run this:

```sh
OPENCODE_DRIVE=1 bun run dev
```

If you installed the skill file, OpenCode will be able to see and interact with the running instance.

## Using with agents

Install the skill file above and ask the agent to test various flows with the app. Start with `--record` when you want a video; `opencode-drive stop` then exports the complete session and prints its path.

Screenshots and videos are written to `<system temp>/opencode-drive/output` with unique filenames. Set `OPENCODE_DRIVE_MEDIA_DIR` to use a different directory.

## UI development

If you are doing UI development in OpenCode, you might want to run it in a simulated mode. This allows `opencode-drive` to drive it and always put it into a state that you want to see.

Run it in visible mode:

```sh
opencode-drive start --visible --dev ~/projects/opencode
```

While developing, you can run `opencode-drive restart` to restart only the UI (the server will persist as a separate process). Do this with agents, and they will always restart and get the UI where you want it to be automatically.

View the [skills file](https://github.com/jlongster/opencode-drive/blob/main/skills/opencode-drive/SKILL.md) for more details about the CLI.
