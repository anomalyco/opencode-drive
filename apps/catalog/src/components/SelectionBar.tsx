import type { Facet, TaxonomyGroup } from "../catalog"
import { label, taxonomyLabel } from "../catalog"

interface SelectionBarProps {
  readonly taxonomy: ReadonlyArray<TaxonomyGroup>
  readonly taxonomyValues: ReadonlyArray<string>
  readonly facets: Readonly<Record<Facet, ReadonlyArray<string>>>
  readonly query: string
  readonly resultCount: number
  readonly onTaxonomy: (value: string) => void
  readonly onFacet: (facet: Facet, value: string) => void
  readonly onClearQuery: () => void
  readonly onClear: () => void
}

export function SelectionBar({
  taxonomy,
  taxonomyValues,
  facets,
  query,
  resultCount,
  onTaxonomy,
  onFacet,
  onClearQuery,
  onClear,
}: SelectionBarProps) {
  const facetValues = (Object.keys(facets) as ReadonlyArray<Facet>).flatMap((facet) =>
    facets[facet].map((value) => ({ facet, value })),
  )
  if (query === "" && taxonomyValues.length === 0 && facetValues.length === 0) return undefined

  return (
    <div className="selection-bar" aria-label="Active filters">
      <span className="selection-label">Active filters</span>
      <div className="selection-chips">
        {query ? (
          <button type="button" onClick={onClearQuery} aria-label={`Remove search filter ${query}`}>
            <small>Search</small> {query} <span aria-hidden="true">×</span>
          </button>
        ) : undefined}
        {taxonomyValues.map((value) => (
          <button type="button" key={value} onClick={() => onTaxonomy(value)}>
            {taxonomyLabel(taxonomy, value)} <span aria-hidden="true">×</span>
          </button>
        ))}
        {facetValues.map(({ facet, value }) => (
          <button type="button" key={`${facet}:${value}`} onClick={() => onFacet(facet, value)}>
            <small>{label(facet)}</small> {label(value)} <span aria-hidden="true">×</span>
          </button>
        ))}
      </div>
      <span className="selection-results">{resultCount} {resultCount === 1 ? "result" : "results"}</span>
      <button type="button" className="selection-clear" onClick={onClear}>Clear all</button>
    </div>
  )
}
