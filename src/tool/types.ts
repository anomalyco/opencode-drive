import * as Schema from "effect/Schema"
import type * as Effect from "effect/Effect"

export const ShellInput = Schema.Struct({
  command: Schema.String,
  workdir: Schema.optional(Schema.String),
  timeout: Schema.optional(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(600_000)),
  ),
  background: Schema.optional(Schema.Boolean),
})
export interface ShellInput extends Schema.Schema.Type<typeof ShellInput> {}

export const ShellResult = Schema.Struct({
  output: Schema.String,
  exit: Schema.optional(Schema.Number),
  shellID: Schema.optional(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
  timeout: Schema.optional(Schema.Boolean),
  status: Schema.optional(Schema.Literals(["completed", "running"])),
  warnings: Schema.optional(Schema.Array(Schema.String)),
})
export interface ShellResult extends Schema.Schema.Type<typeof ShellResult> {}

export class Failure extends Schema.TaggedErrorClass<Failure>()(
  "OpenCodeDrive.ToolFailure",
  { message: Schema.String },
) {}

export interface ShellContext {
  readonly input: ShellInput
  /** Zero-based invocation index for this handler. */
  readonly index: number
  readonly signal: AbortSignal
  readonly progress: (output: string | ShellResult) => Effect.Effect<void>
}

export type ShellHandler = (
  context: ShellContext,
) => Effect.Effect<ShellResult, Failure>

export interface Registry {
  handle(name: "shell", handler: ShellHandler): void
}

export type Setup = (tools: Registry) => void
