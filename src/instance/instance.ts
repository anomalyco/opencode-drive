import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createScriptFileSystem } from "../script/filesystem.js"
import {
  commitScriptProject,
  hasGitMetadata,
  initializeScriptProject,
} from "../script/project.js"
import type {
  OpenCodeConfig,
  OpenCodeTuiConfig,
  ScriptProject,
  ScriptSetup,
} from "../script/types.js"

export function artifactDirectory() {
  return resolve(join(tmpdir(), "opencode-drive"))
}

export async function initializeInstance(name?: string) {
  const artifacts = resolve(
    join(artifactDirectory(), `run-${crypto.randomUUID().slice(0, 6)}`),
  )
  const logs = join(artifacts, "logs")
  const drive = join(artifacts, "drive")
  await Promise.all([
    mkdir(logs, { recursive: true }),
    mkdir(drive, { recursive: true }),
    mkdir(join(artifacts, "home", ".cache"), { recursive: true }),
    mkdir(join(artifacts, "home", ".config"), { recursive: true }),
    mkdir(join(artifacts, "home", ".local", "share"), { recursive: true }),
    mkdir(join(artifacts, "home", ".local", "state"), { recursive: true }),
  ])
  const files = join(artifacts, "files")
  const defaultConfig = await Bun.file(
    new URL("./default-config.jsonc", import.meta.url),
  ).text()
  await Promise.all([
    mkdir(join(files, ".git"), { recursive: true }),
    mkdir(join(files, ".opencode"), { recursive: true }),
    mkdir(join(files, "src"), { recursive: true }),
  ])
  await Promise.all([
    Bun.write(join(files, ".opencode", "opencode.jsonc"), defaultConfig),
    Bun.write(
      join(files, "src", "garden.js"),
      "export function greet(name) {\n  return `Hello, ${name}.`\n}\n",
    ),
    ...(name ? [Bun.write(join(drive, "name"), `${name}\n`)] : []),
  ])
  return artifacts
}

export async function prepareInstanceProject(options: {
  readonly artifacts: string
  readonly project?: ScriptProject
  readonly config?: OpenCodeConfig
  readonly tui?: OpenCodeTuiConfig
  readonly setup?: ScriptSetup
}) {
  const files = join(resolve(options.artifacts), "files")
  const configPath = join(files, ".opencode", "opencode.jsonc")
  const tuiPath = join(files, ".opencode", "tui.jsonc")
  if (options.project) await initializeScriptProject(files, options.project)
  const [config, tui] = await Promise.all([
    readConfig(configPath, "opencode.jsonc"),
    readConfig(tuiPath, "tui.jsonc", {}),
  ])
  deepMerge(config, options.config)
  deepMerge(tui, options.tui)
  const protectGit =
    Boolean(options.project?.git) || (await hasGitMetadata(files))
  await options.setup?.({
    fs: createScriptFileSystem(files, { git: protectGit }),
    config,
    tui,
  })
  await Promise.all([
    Bun.write(configPath, `${JSON.stringify(config, undefined, 2)}\n`),
    Bun.write(tuiPath, `${JSON.stringify(tui, undefined, 2)}\n`),
  ])
  if (options.project?.git) await commitScriptProject(files)
}

async function readConfig(
  path: string,
  name: string,
  fallback?: OpenCodeConfig,
): Promise<OpenCodeConfig> {
  const file = Bun.file(path)
  let value: unknown
  try {
    value = await file.exists()
      ? Bun.JSONC.parse(await file.text())
      : fallback ?? Bun.JSONC.parse(
          await Bun.file(new URL("./default-config.jsonc", import.meta.url)).text(),
        )
  } catch (cause) {
    throw new Error(`invalid .opencode/${name}`, { cause })
  }
  if (!isJsonObject(value))
    throw new Error(`invalid .opencode/${name}: expected a JSON object`)
  return value
}

function deepMerge(target: OpenCodeConfig, source: OpenCodeConfig | undefined) {
  if (source === undefined) return target
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key]
    if (isJsonObject(existing) && isJsonObject(value)) {
      deepMerge(existing, value)
    } else {
      target[key] = value
    }
  }
  return target
}

function isJsonObject(value: unknown): value is OpenCodeConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
