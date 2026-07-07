/**
 * The simplified expected-state model for model-based testing.
 *
 * This is not a copy of OpenCode internals. It captures only the facts we
 * intend to assert against a running OpenCode: which agents/skills/commands
 * exist, which model is configured, what the permission posture is, etc.
 *
 * Initial states seed this model; test commands transition it.
 */
export interface ModelAgent {
  readonly name: string
  readonly disabled: boolean
  readonly hidden: boolean
  readonly mode?: "subagent" | "primary" | "all"
  readonly model?: string
}

export interface ModelPermission {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

export interface ModelSkill {
  readonly name: string
  readonly path: string
}

export interface ProbeModel {
  readonly configuredModel?: string
  readonly defaultAgent?: string
  readonly share?: "manual" | "auto" | "disabled"
  readonly autoupdate?: boolean | "notify"
  readonly agents: ReadonlyMap<string, ModelAgent>
  readonly commands: ReadonlySet<string>
  readonly skills: ReadonlyArray<ModelSkill>
  readonly references: ReadonlyMap<string, string>
  readonly permissions: ReadonlyArray<ModelPermission>
  readonly mcpServers: ReadonlySet<string>
  readonly plugins: ReadonlySet<string>
  readonly providers: ReadonlySet<string>
}
