#!/usr/bin/env bun
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Option } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { send } from "./send.js"
import { describe } from "./describe.js"
import { extractCommands } from "./parse.js"
import { start } from "./start.js"
import type { DriveCommand, SendOptions, StartOptions } from "./types.js"

const extracted = extract()
const name = Flag.string("name").pipe(Flag.optional, Flag.withDescription("Instance name"))
const driver = Flag.string("driver").pipe(Flag.optional, Flag.withDescription("TypeScript driver module"))

const startCommand = Command.make("start", {
  name,
  driver,
  campaign: Flag.string("campaign").pipe(Flag.optional, Flag.withDescription("Campaign module")),
  seed: Flag.integer("seed").pipe(Flag.withDefault(Date.now() % 1_000_000)),
  caseIndex: Flag.integer("case").pipe(
    Flag.filter((value) => value >= 0, () => "Case must be non-negative"),
    Flag.optional,
  ),
  count: Flag.integer("count").pipe(
    Flag.filter((value) => value > 0, () => "Count must be greater than zero"),
    Flag.optional,
  ),
  concurrency: Flag.integer("concurrency").pipe(
    Flag.filter((value) => value > 0, () => "Concurrency must be greater than zero"),
    Flag.withDefault(1),
  ),
  visible: Flag.boolean("visible").pipe(Flag.withDescription("Show OpenCode in the terminal")),
  detach: Flag.boolean("detach").pipe(Flag.withDescription("Keep OpenCode running in the background (default)")),
  dev: Flag.string("dev").pipe(Flag.optional, Flag.withDescription("Path to an OpenCode development checkout")),
  state: Flag.string("state").pipe(Flag.optional, Flag.withDescription("Simulation snapshot containing files/")),
  anchor: Flag.string("anchor").pipe(Flag.optional),
}, (config) => execute(() => start(toStartOptions(config, extracted.commands, extracted.app)))).pipe(
  Command.withDescription("Launch and own a local simulated OpenCode instance"),
  Command.withExamples([
    { command: "opencode-drive start --name demo --visible", description: "Launch a visible simulated instance" },
    { command: "opencode-drive start --name demo --detach", description: "Launch a background simulated instance" },
  ]),
)

const sendCommand = Command.make("send", { name, driver }, (config) =>
  execute(() => send(toSendOptions(config, extracted.commands, extracted.app)))).pipe(
    Command.withDescription("Connect to an existing drive-enabled OpenCode instance"),
    Command.withExamples([
      {
        command: "opencode-drive send --name demo --command.type hello --command.press enter --command.ui-state",
        description: "Execute an ordered command batch",
      },
    ]),
  )

const describeCommand = Command.make("describe", { name }, (config) =>
  execute(() => describe(Option.getOrUndefined(config.name)))).pipe(
    Command.withDescription("Describe a registered OpenCode instance"),
  )

const root = Command.make("opencode-drive").pipe(
  Command.withDescription("Drive real and simulated OpenCode instances"),
  Command.withSubcommands([startCommand, sendCommand, describeCommand]),
)

Command.runWith(root, { version: "0.1.0" })(extracted.args).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)

function toStartOptions(
  config: {
    readonly name: Option.Option<string>
    readonly driver: Option.Option<string>
    readonly campaign: Option.Option<string>
    readonly seed: number
    readonly caseIndex: Option.Option<number>
    readonly count: Option.Option<number>
    readonly concurrency: number
    readonly visible: boolean
    readonly detach: boolean
    readonly dev: Option.Option<string>
    readonly state: Option.Option<string>
    readonly anchor: Option.Option<string>
  },
  commands: ReadonlyArray<DriveCommand>,
  app: ReadonlyArray<string>,
): StartOptions {
  const driver = Option.getOrUndefined(config.driver)
  const campaign = Option.getOrUndefined(config.campaign)
  const visible = config.visible
  const options = {
    kind: "start" as const,
    name: Option.getOrUndefined(config.name),
    driver,
    campaign,
    seed: config.seed,
    caseIndex: Option.getOrUndefined(config.caseIndex),
    count: Option.getOrUndefined(config.count),
    concurrency: config.concurrency,
    visible,
    detach: !visible && (config.detach || (driver === undefined && campaign === undefined && commands.length === 0)),
    dev: Option.getOrUndefined(config.dev),
    state: Option.getOrUndefined(config.state),
    anchor: Option.getOrUndefined(config.anchor),
    command: app,
    commands,
  }
  assertExecutionMode(options.driver, options.campaign, commands)
  if (options.dev !== undefined && app.length > 0) throw new Error("--dev cannot be combined with a command after --")
  if (options.caseIndex !== undefined && options.campaign === undefined) throw new Error("--case requires --campaign")
  if (options.visible && options.campaign !== undefined && options.caseIndex === undefined) {
    throw new Error("visible campaign runs require --case")
  }
  if (config.detach && (options.driver !== undefined || options.campaign !== undefined || commands.length > 0)) {
    throw new Error("--detach cannot be combined with --driver, --campaign, or command flags")
  }
  return options
}

function toSendOptions(
  config: { readonly name: Option.Option<string>; readonly driver: Option.Option<string> },
  commands: ReadonlyArray<DriveCommand>,
  app: ReadonlyArray<string>,
): SendOptions {
  if (app.length > 0) throw new Error("send does not accept a command after --")
  const options = {
    kind: "send" as const,
    name: Option.getOrUndefined(config.name),
    driver: Option.getOrUndefined(config.driver),
    commands,
  }
  assertExecutionMode(options.driver, undefined, commands)
  return options
}

function assertExecutionMode(driver: string | undefined, campaign: string | undefined, commands: ReadonlyArray<DriveCommand>) {
  const count = Number(driver !== undefined) + Number(campaign !== undefined) + Number(commands.length > 0)
  if (count > 1) throw new Error("command flags, --driver, and --campaign are mutually exclusive")
}

function execute(task: () => Promise<void>) {
  return Effect.tryPromise({ try: task, catch: (error) => error }).pipe(
    Effect.catch((error) => Effect.sync(() => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    })),
  )
}

function extract() {
  try {
    return extractCommands(process.argv.slice(2))
  } catch (error) {
    console.error(`opencode-drive: ${error instanceof Error ? error.message : String(error)}`)
    return process.exit(1)
  }
}
