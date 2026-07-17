import type { Variant } from "../catalog"

interface CaptureSetSwitcherProps {
  readonly sets: ReadonlyArray<Variant>
  readonly active: Variant
  readonly position: number
  readonly onNavigate: (direction: 1 | -1) => void
  readonly onSelect: (id: string) => void
}

export function CaptureSetSwitcher({ sets, active, position, onNavigate, onSelect }: CaptureSetSwitcherProps) {
  return (
    <div className="variant-switcher" aria-label="Capture set">
      <button type="button" onClick={() => onNavigate(-1)} aria-label="Newer capture set">↑</button>
      <label title={`${active.revision}${active.theme ? ` / ${active.theme}` : ""}`}>
        <span className="sr-only">Capture set</span>
        <select aria-label="Select capture set" value={active.id} onChange={(event) => onSelect(event.target.value)}>
          {sets.map((set) => (
            <option key={set.id} value={set.id}>{set.label}</option>
          ))}
        </select>
        <small>{position}/{sets.length}</small>
      </label>
      <button type="button" onClick={() => onNavigate(1)} aria-label="Older capture set">↓</button>
    </div>
  )
}
