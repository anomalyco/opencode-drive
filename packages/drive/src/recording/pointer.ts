import { Schema } from "effect"

/** Actual simulation input, timestamped on the terminal recording's clock. */
export const RecordingPointer = Schema.Struct({
  atMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  action: Schema.Literals(["move", "down", "up", "click", "scroll"]),
  x: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  y: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
export interface RecordingPointer extends Schema.Schema.Type<typeof RecordingPointer> {}

const Milliseconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
export const PointerOverlayOptions = Schema.Struct({
  /** Reveal the pointer this long before the next input. Default: 180ms. */
  leadMs: Schema.optionalKey(Milliseconds),
  /** Keep it visible after input, merging nearby interactions. Default: 700ms. */
  lingerMs: Schema.optionalKey(Milliseconds),
  /** Ease between nearby positions, arriving at the input instant. Default: 220ms. */
  motionMs: Schema.optionalKey(Milliseconds),
})
export interface PointerOverlayOptions extends Schema.Schema.Type<typeof PointerOverlayOptions> {}

export interface PointerFrame {
  /** Zero-based terminal cell coordinates, not pixels. */
  readonly x: number
  readonly y: number
  readonly opacity: number
  readonly pressed: boolean
}

export function pointersPath(timeline: string) {
  return `${timeline.replace(/\.jsonl$/, "")}.pointers.jsonl`
}

export async function loadPointers(timeline: string): Promise<ReadonlyArray<RecordingPointer>> {
  const file = Bun.file(pointersPath(timeline))
  if (!(await file.exists())) return []
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(RecordingPointer))
  const events = (await file.text()).split("\n").filter((line) => line.trim() !== "").map((line) => decode(line))
  if (events.some((event, index) => event.atMs < (events[index - 1]?.atMs ?? 0)))
    throw new Error("Recording pointer timestamps must be nondecreasing")
  return events
}

/** Pure raw-timeline interpolation. Never sends input or changes script timing. */
export function pointerAt(
  events: ReadonlyArray<RecordingPointer>,
  atMs: number,
  options: PointerOverlayOptions = {},
): PointerFrame | undefined {
  const lead = options.leadMs ?? 180
  const linger = options.lingerMs ?? 700
  const motion = options.motionMs ?? 220
  const index = events.findLastIndex((event) => event.atMs <= atMs)
  const previous = events[index]
  const next = events[index + 1]
  const button = events.findLast((event) => event.atMs <= atMs &&
    (event.action === "down" || event.action === "up" || event.action === "click"))
  const held = button?.action === "down"
  const fadingOut = previous ? 1 - ease((atMs - previous.atMs - linger + Math.min(120, linger)) / Math.min(120, linger)) : 0
  const fadingIn = next ? ease((atMs - next.atMs + lead) / Math.min(120, lead)) : 0
  const opacity = held ? 1 : Math.max(fadingOut, fadingIn)
  if (opacity <= 0) return undefined
  const destination = next && atMs >= next.atMs - Math.max(lead, motion) ? next : previous
  if (!destination) return undefined
  const connected = previous && (held || destination.atMs - previous.atMs <= linger + lead)
  const start = previous ? Math.max(previous.atMs, destination.atMs - motion) : destination.atMs
  const amount = connected ? ease((atMs - start) / (destination.atMs - start)) : 1
  const origin = connected ? previous : destination
  return {
    x: origin.x + (destination.x - origin.x) * amount,
    y: origin.y + (destination.y - origin.y) * amount,
    opacity,
    pressed: held || (button?.action === "click" && atMs - button.atMs < 120),
  }
}

function ease(value: number) {
  // A zero-duration interval is an immediate transition, including 0 / 0.
  const progress = Number.isNaN(value) ? 1 : Math.max(0, Math.min(1, value))
  return progress * progress * (3 - 2 * progress)
}
