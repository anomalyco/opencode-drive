import type * as Effect from "effect/Effect"
import type * as Tool from "../tool/index.js"
import type * as OpenCodeUi from "../driver/ui.js"
import type * as OpenCodeClient from "../driver/client.js"
import type { Llm } from "../driver/llm.js"
import type * as OpenCodeServer from "../driver/server.js"
import type * as OpenCodeApi from "../driver/api.js"
import type { FileSystemError } from "./errors.js"

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }

/** OpenCode's semantic project configuration, written to opencode.jsonc. */
export interface OpenCodeConfig extends JsonObject {}

/** OpenCode's semantic TUI configuration, written to tui.jsonc. */
export interface OpenCodeTuiConfig extends JsonObject {}

export interface ProjectFileSystem {
  /** Writes inside the simulated project and creates parent directories. */
  writeFile(path: string, contents: string | Uint8Array): Effect.Effect<void, ProjectFileSystemError>
}

export type ProjectFileSystemError = FileSystemError
export type ScriptServerLaunchError = Effect.Error<
  ReturnType<OpenCodeServer.Server["launch"]>
>
export type ScriptServerKillError = Effect.Error<
  ReturnType<OpenCodeServer.Server["kill"]>
>

export interface SetupContext {
  readonly fs: ProjectFileSystem
  /** The current OpenCode config object. Mutate it to customize the run. */
  readonly config: OpenCodeConfig
  /** The current OpenCode TUI config object. Mutate it to customize the run. */
  readonly tui: OpenCodeTuiConfig
}

export interface Project {
  /** Files written into the isolated project before setup runs. */
  readonly files?: Readonly<Record<string, string | Uint8Array>>
  /** Initializes the project as a Git repository and commits its pre-launch state. */
  readonly git?: boolean
}

export interface ScriptServer {
  /** Launches the one shared OpenCode server for this script. */
  launch(): Effect.Effect<OpenCodeApi.Api, ScriptServerLaunchError>
  /** Stops the shared server. It may be launched again afterward. */
  kill(): Effect.Effect<void, ScriptServerKillError>
}

export interface ScriptContext {
  /** Typed client connected to this script's private OpenCode service. */
  readonly api: OpenCodeApi.Api
  readonly fs: ProjectFileSystem
  readonly client: OpenCodeClient.Client
  /** Convenience alias for the primary client's UI. */
  readonly ui: OpenCodeUi.Ui
  readonly clients: OpenCodeClient.Clients
  readonly server: ScriptServer
  readonly llm: Llm
  readonly artifacts: string
}

export interface ManualScriptContext extends Omit<ScriptContext, "client" | "ui" | "api"> {
  readonly ui: null
}

export type Setup = (
  context: SetupContext,
) => Effect.Effect<void, unknown>

export type ScriptRun = (context: ScriptContext) => Effect.Effect<void, unknown>
export type ManualScriptRun = (
  context: ManualScriptContext,
) => Effect.Effect<void, unknown>

export interface AutomaticScriptDefinition {
  /** Declares the isolated project OpenCode runs against. */
  readonly project?: Project
  /** OpenCode configuration merged over project fixture configuration. */
  readonly config?: OpenCodeConfig
  /** OpenCode TUI configuration merged over project fixture configuration. */
  readonly tui?: OpenCodeTuiConfig
  /** Runs once before OpenCode starts. */
  readonly setup?: Setup
  /** Declares built-in tool replacements before OpenCode starts. */
  readonly tools?: Tool.Setup
  /** Configures the automatically launched primary client. */
  readonly client?: OpenCodeClient.Options
  /** Runs after the UI and LLM connections are ready, and again after restart. */
  readonly run: ScriptRun
}

export interface ManualScriptDefinition {
  /** The server and every client are launched explicitly by the script. */
  readonly launch: "manual"
  /** Declares the isolated project OpenCode runs against. */
  readonly project?: Project
  /** OpenCode configuration merged over project fixture configuration. */
  readonly config?: OpenCodeConfig
  /** OpenCode TUI configuration merged over project fixture configuration. */
  readonly tui?: OpenCodeTuiConfig
  /** Runs once before OpenCode starts. */
  readonly setup?: Setup
  /** Declares built-in tool replacements before OpenCode starts. */
  readonly tools?: Tool.Setup
  /** Defaults for clients launched by the script. */
  readonly client?: OpenCodeClient.Options
  /** Runs after the shared service and LLM connection are ready. */
  readonly run: ManualScriptRun
}

export type ScriptDefinitionInput =
  | AutomaticScriptDefinition
  | ManualScriptDefinition

export type ScriptDefinition = ScriptDefinitionInput & {
  readonly kind: "opencode-drive/script"
}
