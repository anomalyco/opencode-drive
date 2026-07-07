import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { DefinedCampaign } from "../campaign-api.js"
import { connectDrive } from "../drive.js"
import { launchInstance } from "./instance.js"
import type { StartOptions } from "./types.js"

interface CaseResult {
  readonly index: number
  readonly seed: number
  readonly status: "passed" | "failed"
  readonly durationMs: number
  readonly artifacts: string
  readonly error?: string
  readonly result?: unknown
}

export async function runCampaign(options: StartOptions) {
  const file = resolve(options.campaign!)
  const campaign = await loadCampaign(file)
  const root = resolve(process.env.DRIVE_CAMPAIGN_ROOT ?? join(tmpdir(), `opencode-drive-campaign-${Date.now()}`))
  const indexes = options.caseIndex === undefined
    ? Array.from({ length: options.count ?? campaign.count ?? 1 }, (_, index) => index)
    : [options.caseIndex]
  if (indexes.length === 0) throw new Error("campaign count must be greater than zero")
  await mkdir(root, { recursive: true })
  const results: CaseResult[] = []
  const cursor = { value: 0 }
  const controller = new AbortController()
  const active = new Set<Awaited<ReturnType<typeof launchInstance>>>()
  const interrupt = () => {
    controller.abort()
    void Promise.all([...active].map((instance) => instance.stop(true)))
  }
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  try {
    const workers = Array.from(
      { length: Math.min(options.visible ? 1 : options.concurrency, indexes.length) },
      async () => {
        while (!controller.signal.aborted && cursor.value < indexes.length) {
          const index = indexes[cursor.value++]!
          const result = await runCase(campaign, file, root, index, options, controller.signal, active)
          results.push(result)
          console.log(`[${results.length}/${indexes.length}] case=${index} seed=${result.seed} ${result.status}`)
        }
      },
    )
    await Promise.all(workers)
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
    await Promise.all([...active].map((instance) => instance.stop(true)))
  }
  if (controller.signal.aborted) throw new Error("campaign interrupted")
  results.sort((a, b) => a.index - b.index)
  const summary = {
    campaign: file,
    seed: options.seed,
    count: results.length,
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    durationMs: results.reduce((total, result) => total + result.durationMs, 0),
    results,
  }
  await Bun.write(resolve(root, "summary.json"), `${JSON.stringify(summary, undefined, 2)}\n`)
  if (summary.failed > 0) throw new Error(`${summary.failed} campaign case${summary.failed === 1 ? "" : "s"} failed; see ${root}`)
  console.log(JSON.stringify(summary, undefined, 2))
}

async function runCase(
  campaign: DefinedCampaign,
  campaignFile: string,
  root: string,
  index: number,
  options: StartOptions,
  signal: AbortSignal,
  active: Set<Awaited<ReturnType<typeof launchInstance>>>,
): Promise<CaseResult> {
  const seed = options.seed + index
  const artifacts = resolve(root, `case-${String(index).padStart(6, "0")}-${seed}`)
  const started = Date.now()
  await mkdir(artifacts, { recursive: true })
  const generated = { index, seed, artifacts }
  try {
    const flow = await campaign.generate(generated)
    await Bun.write(resolve(artifacts, "flow.json"), `${JSON.stringify(flow, undefined, 2)}\n`)
    const prepared = await campaign.prepare?.({ ...generated, flow })
    const instance = await launchInstance({
      name: `campaign-${process.pid}-${index}`,
      command: options.command.length > 0 ? options.command : prepared?.command,
      dev: options.dev,
      state: prepared?.state ?? options.state,
      visible: options.visible,
      env: prepared?.env,
    })
    active.add(instance)
    try {
      await instance.waitForDrive("both")
      const session = await connectDrive(instance.manifest.endpoints)
      try {
        const result = await campaign.run({
          ...generated,
          flow,
          name: instance.manifest.name,
          ui: session.ui,
          backend: session.backend,
          signal,
        })
        const value: CaseResult = {
          index,
          seed,
          status: "passed",
          durationMs: Date.now() - started,
          artifacts,
          result,
        }
        await Bun.write(resolve(artifacts, "result.json"), `${JSON.stringify(value, undefined, 2)}\n`)
        return value
      } finally {
        session.close()
      }
    } finally {
      active.delete(instance)
      await instance.stop(true)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const result: CaseResult = {
      index,
      seed,
      status: "failed",
      durationMs: Date.now() - started,
      artifacts,
      error: message,
    }
    await Bun.write(resolve(artifacts, "failure.json"), `${JSON.stringify({
      ...result,
      replay: replayCommand(campaignFile, index, options),
    }, undefined, 2)}\n`)
    return result
  }
}

function replayCommand(campaignFile: string, index: number, options: StartOptions) {
  const args = [
    "opencode-drive",
    "run",
    "--campaign",
    campaignFile,
    "--seed",
    String(options.seed),
    "--case",
    String(index),
    "--visible",
    ...(options.state ? ["--state", options.state] : []),
    ...(options.anchor ? ["--anchor", options.anchor] : []),
    ...(options.command.length > 0 ? ["--", ...options.command] : []),
  ]
  return args.map((arg) => JSON.stringify(arg)).join(" ")
}

async function loadCampaign(file: string): Promise<DefinedCampaign> {
  const module: { readonly default?: unknown } = await import(`${pathToFileURL(file).href}?drive=${Date.now()}`)
  const value = module.default
  if (!isCampaign(value)) {
    throw new Error(`${basename(file)} must default-export defineCampaign(...)`)
  }
  return value
}

function isCampaign(value: unknown): value is DefinedCampaign {
  if (typeof value !== "object" || value === null) return false
  if (!("kind" in value) || value.kind !== "opencode-drive/campaign") return false
  if (!("generate" in value) || typeof value.generate !== "function") return false
  return "run" in value && typeof value.run === "function"
}
