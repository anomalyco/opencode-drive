import type { OpenCodeConfig } from "../project.js"

export const defaultConfig = {
  model: "simulation/gpt-sim-model",
  snapshots: false,
  permissions: [{ action: "*", resource: "*", effect: "allow" }],
  providers: {
    simulation: {
      name: "Simulation",
      package: "@opencode-ai/ai/providers/openai/chat",
      settings: { apiKey: "sim-key" },
      models: {
        "gpt-sim-model": {
          name: "Simulated Model",
          capabilities: {
            tools: true,
            input: ["text"],
            output: ["text"],
          },
          limit: { context: 128_000, output: 16_000 },
        },
      },
    },
  },
} satisfies OpenCodeConfig
