import * as Effect from "effect/Effect"
import { OpenCodeDriver } from "../src/index.js"
import type {
  Client,
  Clients,
  Frontend,
  Project,
  Ui,
} from "../src/index.js"
import type { ScriptContext } from "../src/script/types.js"

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false

type Assert<Value extends true> = Value

export type ScriptUiIsCanonical = Assert<Equal<ScriptContext["ui"], Ui>>
export type ScriptClientIsCanonical = Assert<
  Equal<ScriptContext["client"], Client>
>
export type ScriptClientsAreCanonical = Assert<
  Equal<ScriptContext["clients"], Clients>
>
export type LaunchedClientIsCanonical = Assert<
  Equal<Effect.Success<ReturnType<Clients["launch"]>>, Client>
>
export type ResizeIsCanonicalAction = Assert<
  Equal<
    Extract<Frontend.Action, { readonly type: "ui.resize" }>,
    {
      readonly type: "ui.resize"
      readonly cols: number
      readonly rows: number
    }
  >
>
export type DriverProjectIsCanonical = Assert<
  Equal<NonNullable<OpenCodeDriver.Options["project"]>, Project>
>

const zeroConfig = OpenCodeDriver.use(() => Effect.void)
export type ZeroConfigUseIsRunnable = Assert<
  Equal<Effect.Services<typeof zeroConfig>, never>
>
