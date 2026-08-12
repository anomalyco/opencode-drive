import type { Variant } from "../catalog"

interface CaptureSetSwitcherProps {
  readonly sets: ReadonlyArray<Variant>
  readonly active: Variant
  readonly onSelect: (id: string) => void
}

export function CaptureSetSwitcher({ sets, active, onSelect }: CaptureSetSwitcherProps) {
  return (
    <label className="variant-switcher" title={`${active.revision}${active.theme ? ` / ${active.theme}` : ""}`}>
      <span className="sr-only">Capture set</span>
      <select aria-label="Select capture set" value={active.id} onChange={(event) => onSelect(event.target.value)}>
        {sets.map((set) => (
          <option key={set.id} value={set.id}>{set.label}</option>
        ))}
      </select>
      <span className="variant-chevron" aria-hidden="true">↓</span>
    </label>
  )
}
