import type { Screen } from "../catalog"
import { label } from "../catalog"

interface MatrixNavigationProps {
  readonly screens: ReadonlyArray<Screen>
  readonly states: ReadonlyArray<string>
  readonly selectedStates: ReadonlyArray<string>
  readonly onState: (state: string) => void
}

export function MatrixNavigation({ screens, states, selectedStates, onState }: MatrixNavigationProps) {
  const selected = new Set(selectedStates)
  const categories = Array.from(
    screens.reduce((counts, screen) => counts.set(screen.category, (counts.get(screen.category) ?? 0) + 1), new Map<string, number>()),
  )
  const stateCounts = new Map<string, number>()
  for (const screen of screens) {
    for (const state of screen.states) stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1)
  }

  return (
    <nav className="matrix-navigation" aria-label="Browse matrix">
      <div className="matrix-categories" aria-label="Screen families">
        <span className="matrix-label">Family</span>
        {categories.map(([category, count]) => (
          <a key={category} href={`#family-${category}`}>
            {label(category)} <small>{count}</small>
          </a>
        ))}
      </div>
      <div className="matrix-states" aria-label="Lifecycle states">
        <span className="matrix-label">State</span>
        {states.map((state) => {
          const count = stateCounts.get(state) ?? 0
          if (count === 0 && !selected.has(state)) return undefined
          const active = selected.has(state)
          return (
            <button
              type="button"
              key={state}
              className={active ? "active" : ""}
              aria-pressed={active}
              onClick={() => onState(state)}
            >
              {label(state)} <small>{count}</small>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
