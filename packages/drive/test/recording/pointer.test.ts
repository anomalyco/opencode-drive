import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadPointers, pointerAt, pointersPath, PointerOverlayOptions, type RecordingPointer } from "../../src/recording/pointer.js"

const click: RecordingPointer = { action: "click", atMs: 1_000, x: 10, y: 5 }

describe("recorded pointer", () => {
  it.live("loads portable raw timestamps and rejects malformed or out-of-order sidecars", () => Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "drive-pointer-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    )
    const timeline = join(directory, "timeline.jsonl")
    expect(yield* Effect.promise(() => loadPointers(timeline))).toEqual([])
    yield* Effect.promise(() => Bun.write(pointersPath(timeline), JSON.stringify(click) + "\n"))
    expect(yield* Effect.promise(() => loadPointers(timeline))).toEqual([click])
    yield* Effect.promise(() => Bun.write(pointersPath(timeline), JSON.stringify({ ...click, x: -1 }) + "\n"))
    expect(yield* Effect.tryPromise(() => loadPointers(timeline)).pipe(Effect.isFailure)).toBe(true)
    yield* Effect.promise(() => Bun.write(pointersPath(timeline), [click, { ...click, atMs: 1 }].map((event) => JSON.stringify(event)).join("\n")))
    expect(yield* Effect.tryPromise(() => loadPointers(timeline)).pipe(Effect.isFailure)).toBe(true)
  }))
  it("appears before input, lands at the real cell and fades after it", () => {
    expect(pointerAt([click], 800)).toBeUndefined()
    expect(pointerAt([click], 900)).toMatchObject({ x: 10, y: 5, pressed: false })
    expect(pointerAt([click], 1_000)).toEqual({ x: 10, y: 5, opacity: 1, pressed: true })
    expect(pointerAt([click], 1_400)?.opacity).toBe(1)
    expect(pointerAt([click], 1_650)?.opacity).toBeLessThan(1)
    expect(pointerAt([click], 1_700)).toBeUndefined()
  })

  it("keeps nearby clicks connected with smooth arrival and no early jump", () => {
    const second = { ...click, atMs: 1_500, x: 30 }
    expect(pointerAt([click, second], 1_200)).toMatchObject({ x: 10, opacity: 1 })
    expect(pointerAt([click, second], 1_390)).toMatchObject({ x: 20, opacity: 1 })
    expect(pointerAt([click, second], 1_500)).toMatchObject({ x: 30, opacity: 1, pressed: true })
  })

  it("does not fly across idle gaps and stays visible during a held drag", () => {
    const later = { ...click, atMs: 5_000, x: 80 }
    expect(pointerAt([click, later], 1_300)).toMatchObject({ x: 10 })
    expect(pointerAt([click, later], 3_000)).toBeUndefined()
    expect(pointerAt([click, later], 4_900)).toMatchObject({ x: 80 })
    const drag: ReadonlyArray<RecordingPointer> = [
      { ...click, action: "down" },
      { action: "move", atMs: 1_500, x: 20, y: 5 },
      { action: "up", atMs: 5_000, x: 30, y: 5 },
    ]
    expect(pointerAt(drag, 3_000)).toMatchObject({ x: 20, opacity: 1, pressed: true })
    expect(pointerAt(drag, 5_000)?.pressed).toBe(false)
    expect(pointerAt(drag, 5_700)).toBeUndefined()
  })

  it("supports simultaneous events, disabled motion and zero visibility windows", () => {
    expect(pointerAt([click, { ...click, action: "up" }], 1_000)).toMatchObject({ x: 10, pressed: false })
    expect(pointerAt([click], 900, { leadMs: 0 })).toBeUndefined()
    expect(pointerAt([click], 1_001, { lingerMs: 0 })).toBeUndefined()
    expect(pointerAt([click, { ...click, atMs: 1_500, x: 30 }], 1_450, { motionMs: 0 })?.x).toBe(10)
    expect(pointerAt([], 0)).toBeUndefined()
    expect(() => Schema.decodeUnknownSync(PointerOverlayOptions)({ leadMs: -1 })).toThrow()
  })
})
