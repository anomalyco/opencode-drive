export interface Rng {
  readonly next: () => number
  readonly int: (minimum: number, maximum: number) => number
  readonly boolean: (probability?: number) => boolean
  readonly pick: <T>(items: ReadonlyArray<T>) => T
  readonly sample: <T>(items: ReadonlyArray<T>, count: number) => T[]
  readonly subset: <T>(items: ReadonlyArray<T>, minimum?: number, maximum?: number) => T[]
}

/** Deterministic mulberry32-style RNG so generated fixtures are reproducible per seed. */
export const createRng = (seed: number): Rng => {
  let state = seed >>> 0 || 1
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (minimum: number, maximum: number) => minimum + Math.floor(next() * (maximum - minimum + 1))
  const boolean = (probability = 0.5) => next() < probability
  const pick = <T>(items: ReadonlyArray<T>): T => {
    if (items.length === 0) throw new Error("Cannot pick from an empty list")
    return items[int(0, items.length - 1)]!
  }
  const sample = <T>(items: ReadonlyArray<T>, count: number): T[] => {
    const copy = [...items]
    const out: T[] = []
    while (out.length < count && copy.length > 0) out.push(copy.splice(int(0, copy.length - 1), 1)[0]!)
    return out
  }
  const subset = <T>(items: ReadonlyArray<T>, minimum = 0, maximum = items.length): T[] =>
    sample(items, int(Math.min(minimum, items.length), Math.min(maximum, items.length)))
  return { next, int, boolean, pick, sample, subset }
}
