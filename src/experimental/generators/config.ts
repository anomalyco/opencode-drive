import { createRng, type Rng } from "./random.js"

/**
 * Profile-based OpenCode config generation.
 *
 * Unlike `Schema.toArbitrary`, these generators produce configs a person could
 * plausibly have written, while still covering most schema branches:
 *
 * - minimal: the smallest useful configs
 * - typical: realistic daily-driver configs
 * - maximal: every major section populated
 * - edge: unusual-but-valid shapes (disabled agents, deny-all permissions, ...)
 */
export type ConfigProfile = "minimal" | "typical" | "maximal" | "edge"

export const configProfiles: ReadonlyArray<ConfigProfile> = ["minimal", "typical", "maximal", "edge"]

export type ConfigJson = Record<string, unknown>

const schemaUrl = "https://opencode.ai/config.json"

const models = [
  "opencode/gpt-5.5",
  "opencode/big-pickle",
  "opencode/claude-sonnet-4-5",
  "anthropic/claude-sonnet-4-5",
  "openai/gpt-5-codex",
]

const agentNames = ["reviewer", "researcher", "planner", "tester", "docs"]

const agentDescriptions: Record<string, string> = {
  reviewer: "Reviews changes for bugs, regressions, and risky patterns",
  researcher: "Explores the codebase and summarizes findings with references",
  planner: "Breaks work into small verifiable steps before editing",
  tester: "Writes and runs focused tests around changed behavior",
  docs: "Writes and updates documentation to match the code",
}

const permissionPool: ReadonlyArray<ConfigJson> = [
  { action: "bash", resource: "git *", effect: "allow" },
  { action: "bash", resource: "*", effect: "ask" },
  { action: "edit", resource: "src/**", effect: "allow" },
  { action: "edit", resource: "*", effect: "ask" },
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "webfetch", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "deny" },
  { action: "question", resource: "*", effect: "deny" },
]

const commandPool: Record<string, string> = {
  review: "Review the current diff for bugs and risky changes.",
  explain: "Explain what the selected code does and why it exists.",
  triage: "Summarize this issue and propose concrete next steps.",
  ship: "Prepare a release summary from recent commits.",
}

const permissions = (rng: Rng, minimum: number, maximum: number): ConfigJson[] =>
  rng.subset(permissionPool, minimum, maximum).map((rule) => ({ ...rule }))

const agent = (rng: Rng, name: string): ConfigJson => ({
  description: agentDescriptions[name] ?? `Helps with ${name}`,
  ...(rng.boolean(0.7) ? { model: rng.pick(models) } : {}),
  ...(rng.boolean(0.4) ? { mode: rng.pick(["subagent", "primary", "all"]) } : {}),
  ...(rng.boolean(0.3) ? { system: `You are the ${name} agent. Stay focused and concise.` } : {}),
  ...(rng.boolean(0.3) ? { steps: rng.int(4, 24) } : {}),
  ...(rng.boolean(0.25) ? { color: rng.pick(["primary", "accent", "#4f46e5", "#0ea5e9"]) } : {}),
  ...(rng.boolean(0.3) ? { permissions: permissions(rng, 1, 3) } : {}),
})

const agents = (rng: Rng, names: ReadonlyArray<string>): ConfigJson =>
  Object.fromEntries(names.map((name) => [name, agent(rng, name)]))

const commands = (rng: Rng, count: number): ConfigJson =>
  Object.fromEntries(
    rng.sample(Object.keys(commandPool), count).map((name) => [
      name,
      {
        template: commandPool[name]!,
        ...(rng.boolean(0.4) ? { agent: rng.pick(agentNames) } : {}),
        ...(rng.boolean(0.3) ? { model: rng.pick(models) } : {}),
        ...(rng.boolean(0.2) ? { subtask: rng.boolean() } : {}),
      },
    ]),
  )

const references = (rng: Rng): ConfigJson => ({
  docs: "./docs",
  ...(rng.boolean(0.6) ? { design: { path: "./design", description: "Product and architecture notes" } } : {}),
  ...(rng.boolean(0.4)
    ? {
        opencode: {
          repository: "https://github.com/anomalyco/opencode",
          branch: "dev",
          description: "OpenCode source checkout",
        },
      }
    : {}),
})

const mcp = (rng: Rng): ConfigJson => ({
  ...(rng.boolean(0.4) ? { timeout: { startup: 10_000, request: 30_000 } } : {}),
  servers: {
    filesystem: {
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
      ...(rng.boolean(0.3) ? { environment: { MCP_FS_READONLY: "1" } } : {}),
    },
    ...(rng.boolean(0.5)
      ? {
          linear: {
            type: "remote",
            url: "https://mcp.linear.app/sse",
            ...(rng.boolean(0.5) ? { headers: { Authorization: "Bearer ${LINEAR_TOKEN}" } } : {}),
          },
        }
      : {}),
  },
})

const providers = (rng: Rng): ConfigJson => ({
  local: {
    name: "Local OpenAI-compatible",
    api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "http://localhost:11434/v1" },
    ...(rng.boolean(0.3) ? { env: ["LOCAL_API_KEY"] } : {}),
    models: {
      "llama-3.3-70b": {
        name: "Llama 3.3 70B",
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        limit: { context: 131072, output: 8192 },
        ...(rng.boolean(0.3) ? { cost: { input: 0, output: 0 } } : {}),
      },
    },
  },
})

const formatter = (rng: Rng): ConfigJson => ({
  prettier: { command: ["prettier", "--write", "$FILE"], extensions: [".ts", ".tsx", ".md"] },
  ...(rng.boolean(0.3) ? { gofmt: { disabled: true } } : {}),
})

const lsp = (): ConfigJson => ({
  typescript: { command: ["typescript-language-server", "--stdio"], extensions: [".ts", ".tsx"] },
  eslint: { disabled: true },
})

const minimal = (rng: Rng): ConfigJson => ({
  $schema: schemaUrl,
  model: rng.pick(models),
  ...(rng.boolean(0.3) ? { share: "manual" } : {}),
})

const typical = (rng: Rng): ConfigJson => {
  const names = rng.sample(agentNames, rng.int(1, 2))
  return {
    $schema: schemaUrl,
    model: rng.pick(models),
    ...(rng.boolean(0.5) ? { default_agent: names[0] } : {}),
    ...(rng.boolean(0.5) ? { autoupdate: rng.pick<boolean | string>([true, false, "notify"]) } : {}),
    share: rng.pick(["manual", "auto"]),
    permissions: permissions(rng, 2, 4),
    agents: agents(rng, names),
    ...(rng.boolean(0.6) ? { skills: ["./skills"] } : {}),
    ...(rng.boolean(0.6) ? { instructions: ["AGENTS.md"] } : {}),
    ...(rng.boolean(0.5) ? { commands: commands(rng, rng.int(1, 2)) } : {}),
  }
}

const maximal = (rng: Rng): ConfigJson => {
  const names = rng.sample(agentNames, rng.int(3, 4))
  return {
    $schema: schemaUrl,
    model: rng.pick(models),
    default_agent: names[0],
    autoupdate: rng.pick<boolean | string>([true, "notify"]),
    share: rng.pick(["manual", "auto"]),
    username: rng.pick(["james", "kit", "dax", "adam"]),
    snapshots: rng.boolean(0.8),
    permissions: permissions(rng, 3, 6),
    agents: agents(rng, names),
    watcher: { ignore: ["node_modules/**", "dist/**", ...(rng.boolean(0.5) ? [".git/**"] : [])] },
    formatter: formatter(rng),
    lsp: lsp(),
    attachments: { image: { auto_resize: true, max_width: 1568, max_height: 1568 } },
    tool_output: { max_lines: rng.int(200, 2000), max_bytes: rng.int(16, 256) * 1024 },
    mcp: mcp(rng),
    compaction: {
      auto: true,
      ...(rng.boolean(0.5) ? { prune: true } : {}),
      keep: { tokens: rng.int(4, 32) * 1024 },
      buffer: rng.int(2, 16) * 1024,
    },
    skills: ["./skills", ...(rng.boolean(0.3) ? ["https://github.com/anomalyco/skills"] : [])],
    commands: commands(rng, rng.int(2, 4)),
    instructions: ["AGENTS.md", ...(rng.boolean(0.5) ? ["docs/style.md"] : [])],
    references: references(rng),
    plugins: ["opencode-notify", { package: "opencode-datadog", options: { site: "datadoghq.com" } }],
    providers: providers(rng),
  }
}

const edge = (rng: Rng): ConfigJson => {
  const disabledAgent = rng.pick(agentNames)
  return {
    $schema: schemaUrl,
    ...(rng.boolean(0.5) ? {} : { model: rng.pick(models) }),
    autoupdate: "notify",
    share: "disabled",
    snapshots: false,
    lsp: false,
    formatter: false,
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      ...(rng.boolean(0.5) ? [{ action: "read", resource: "*", effect: "allow" }] : []),
    ],
    agents: {
      [disabledAgent]: { ...agent(rng, disabledAgent), disabled: true, hidden: true },
    },
    skills: [],
    instructions: [],
    commands: {},
    mcp: {},
    tool_output: { max_lines: 5, max_bytes: 1024 },
    compaction: { auto: false, prune: true, keep: { tokens: 0 }, buffer: 0 },
  }
}

export interface GenerateConfigOptions {
  readonly seed: number
  readonly profile?: ConfigProfile
}

export const generateConfigJson = (options: GenerateConfigOptions): ConfigJson => {
  const rng = createRng(options.seed)
  const profile = options.profile ?? rng.pick(configProfiles)
  if (profile === "minimal") return minimal(rng)
  if (profile === "typical") return typical(rng)
  if (profile === "maximal") return maximal(rng)
  return edge(rng)
}
