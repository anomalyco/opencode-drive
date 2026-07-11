import type { ScriptProject } from "./types.js"
import { createScriptFileSystem } from "./filesystem.js"
import { rm } from "node:fs/promises"
import { join } from "node:path"

export async function initializeScriptProject(
  root: string,
  project: ScriptProject,
) {
  const fs = createScriptFileSystem(root, { git: true })
  await Promise.all(
    Object.entries(project.git.files).map(([path, contents]) =>
      fs.writeFile(path, contents),
    ),
  )
}

export async function commitScriptProject(root: string) {
  await rm(join(root, ".git"), { recursive: true, force: true })
  await git(root, ["init", "--quiet", "--initial-branch=main"])
  await git(root, ["add", "--force", "--all"])
  await git(root, [
    "-c",
    "user.name=OpenCode Drive",
    "-c",
    "user.email=drive@opencode.ai",
    "commit",
    "--quiet",
    "--message=Initial commit",
  ])
}

async function git(cwd: string, args: ReadonlyArray<string>) {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...stripGitEnvironment(Bun.env),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
  })
  const [status, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ])
  if (status === 0) return
  throw new Error(`git ${args[0]} failed: ${stderr.trim()}`)
}

export function stripGitEnvironment(
  env: Readonly<Record<string, string | undefined>>,
) {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("GIT_"),
    ),
  )
}
