import type { InitialState } from "../generators/initial-state.js"
import { normalizePath } from "../generators/filesystem.js"
import type { ModelAgent, ModelPermission, ModelSkill, ProbeModel } from "./model.js"

/**
 * Derives the expected model from an initial state.
 *
 * Mirrors how OpenCode interprets the config and filesystem, but only for the
 * facts the model asserts. Skill discovery intentionally follows core's
 * `{*.md,**\/SKILL.md}` + frontmatter-name rules.
 */
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

const frontmatter = (content: string): Record<string, string> => {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const out: Record<string, string> = {}
  for (const line of match[1]!.split("\n")) {
    const colon = line.indexOf(":")
    if (colon === -1) continue
    out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  return out
}

const deriveAgents = (config: Record<string, unknown>): Map<string, ModelAgent> => {
  const out = new Map<string, ModelAgent>()
  for (const [name, value] of Object.entries(asRecord(config.agents) ?? {})) {
    const entry = asRecord(value) ?? {}
    const mode = entry.mode
    out.set(name, {
      name,
      disabled: entry.disabled === true,
      hidden: entry.hidden === true,
      ...(mode === "subagent" || mode === "primary" || mode === "all" ? { mode } : {}),
      ...(asString(entry.model) === undefined ? {} : { model: asString(entry.model)! }),
    })
  }
  return out
}

const derivePermissions = (config: Record<string, unknown>): ModelPermission[] => {
  if (!Array.isArray(config.permissions)) return []
  return config.permissions.flatMap((value) => {
    const rule = asRecord(value)
    const action = asString(rule?.action)
    const resource = asString(rule?.resource)
    const effect = rule?.effect
    if (action === undefined || resource === undefined) return []
    if (effect !== "allow" && effect !== "deny" && effect !== "ask") return []
    return [{ action, resource, effect }]
  })
}

const deriveSkills = (state: InitialState): ModelSkill[] => {
  const sources = stringArray(state.config.skills)
    .filter((source) => !source.includes("://"))
    .map(normalizePath)
  const skills: ModelSkill[] = []
  for (const source of sources) {
    const prefix = `${source}/`
    for (const file of state.files.files) {
      if (!file.path.startsWith(prefix)) continue
      const rest = file.path.slice(prefix.length)
      const isRootMarkdown = !rest.includes("/") && rest.endsWith(".md")
      const isNestedSkill = rest.endsWith("/SKILL.md")
      if (!isRootMarkdown && !isNestedSkill) continue
      const name = frontmatter(file.content).name ?? (isRootMarkdown ? rest.slice(0, -3) : undefined)
      if (name !== undefined) skills.push({ name, path: file.path })
    }
  }
  return skills
}

const deriveReferences = (config: Record<string, unknown>): Map<string, string> => {
  const out = new Map<string, string>()
  for (const [name, value] of Object.entries(asRecord(config.references) ?? {})) {
    const target =
      asString(value) ?? asString(asRecord(value)?.path) ?? asString(asRecord(value)?.repository)
    if (target !== undefined) out.set(name, target)
  }
  return out
}

const derivePlugins = (config: Record<string, unknown>): Set<string> => {
  const out = new Set<string>()
  if (!Array.isArray(config.plugins)) return out
  for (const entry of config.plugins) {
    const name = asString(entry) ?? asString(asRecord(entry)?.package)
    if (name !== undefined) out.add(name)
  }
  return out
}

export const deriveModel = (state: InitialState): ProbeModel => {
  const config = state.config
  const share = config.share
  const autoupdate = config.autoupdate
  return {
    ...(asString(config.model) === undefined ? {} : { configuredModel: asString(config.model)! }),
    ...(asString(config.default_agent) === undefined ? {} : { defaultAgent: asString(config.default_agent)! }),
    ...(share === "manual" || share === "auto" || share === "disabled" ? { share } : {}),
    ...(typeof autoupdate === "boolean" || autoupdate === "notify" ? { autoupdate } : {}),
    agents: deriveAgents(config),
    commands: new Set(Object.keys(asRecord(config.commands) ?? {})),
    skills: deriveSkills(state),
    references: deriveReferences(config),
    permissions: derivePermissions(config),
    mcpServers: new Set(Object.keys(asRecord(asRecord(config.mcp)?.servers) ?? {})),
    plugins: derivePlugins(config),
    providers: new Set(Object.keys(asRecord(config.providers) ?? {})),
  }
}
