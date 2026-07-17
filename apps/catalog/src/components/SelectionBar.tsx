import type { Facet, TaxonomyGroup } from "../catalog"
import { label, taxonomyLabel } from "../catalog"

interface SelectionBarProps {
  readonly taxonomy: ReadonlyArray<TaxonomyGroup>
  readonly taxonomyValues: ReadonlyArray<string>
  readonly facets: Readonly<Record<Facet, ReadonlyArray<string>>>
  readonly onTaxonomy: (value: string) => void
  readonly onFacet: (facet: Facet, value: string) => void
  readonly onClear: () => void
}

export function SelectionBar({
  taxonomy,
  taxonomyValues,
  facets,
  onTaxonomy,
  onFacet,
  onClear,
}: SelectionBarProps) {
  const facetValues = (Object.keys(facets) as ReadonlyArray<Facet>).flatMap((facet) =>
    facets[facet].map((value) => ({ facet, value })),
  )
  if (taxonomyValues.length === 0 && facetValues.length === 0) return undefined

  return (
    <div className="selection-bar" aria-label="Active filters">
      <div className="selection-chips">
        {taxonomyValues.map((value) => (
          <button type="button" key={value} onClick={() => onTaxonomy(value)}>
            {taxonomyLabel(taxonomy, value)} <span aria-hidden="true">×</span>
          </button>
        ))}
        {facetValues.map(({ facet, value }) => (
          <button type="button" key={`${facet}:${value}`} onClick={() => onFacet(facet, value)}>
            {label(value)} <span aria-hidden="true">×</span>
          </button>
        ))}
      </div>
      <button type="button" className="selection-clear" onClick={onClear}>
        Clear all
      </button>
    </div>
  )
}
