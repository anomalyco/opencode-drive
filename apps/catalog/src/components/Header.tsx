import type { Ref } from "react"
import type { BrowseMode, Catalog, Facet, FacetSelections, TaxonomyGroup, Variant } from "../catalog"
import { label } from "../catalog"
import { FilterMenu } from "./FilterMenu"

interface HeaderProps {
  readonly catalog: Catalog
  readonly mode: BrowseMode
  readonly taxonomyValues: ReadonlyArray<string>
  readonly facets: FacetSelections
  readonly query: string
  readonly resultCount: number
  readonly taxonomyCounts: ReadonlyMap<string, number>
  readonly searchRef: Ref<HTMLInputElement>
  readonly variant: Variant
  readonly variantPosition: number
  readonly onMode: (mode: BrowseMode) => void
  readonly onQuery: (query: string) => void
  readonly onTaxonomy: (value: string) => void
  readonly onClearTaxonomy: () => void
  readonly onFacet: (facet: Facet, value: string) => void
  readonly onClearFacets: () => void
  readonly onClearSearch: () => void
  readonly onOpenPalette: () => void
  readonly onVariant: (direction: 1 | -1) => void
}

const modes: ReadonlyArray<readonly [BrowseMode, string]> = [
  ["screens", "Screens"],
  ["ui-elements", "UI Elements"],
  ["flows", "Specimens"],
]

export function Header({
  catalog,
  mode,
  taxonomyValues,
  facets,
  query,
  resultCount,
  taxonomyCounts,
  searchRef,
  variant,
  variantPosition,
  onMode,
  onQuery,
  onTaxonomy,
  onClearTaxonomy,
  onFacet,
  onClearFacets,
  onClearSearch,
  onOpenPalette,
  onVariant,
}: HeaderProps) {
  const taxonomy = mode === "screens" ? catalog.screenTaxonomy : catalog.uiElementTaxonomy
  const facetGroups: ReadonlyArray<TaxonomyGroup> = [
    { id: "surface", label: "Surface", items: catalog.surfaces.map((value) => ({ id: `surface:${value}`, label: label(value) })) },
    { id: "pattern", label: "Pattern", items: catalog.patterns.map((value) => ({ id: `pattern:${value}`, label: label(value) })) },
    { id: "feature", label: "Feature", items: catalog.features.map((value) => ({ id: `feature:${value}`, label: label(value) })) },
    { id: "state", label: "State", items: catalog.states.map((value) => ({ id: `state:${value}`, label: label(value) })) },
  ]
  const selectedFacets = (Object.keys(facets) as ReadonlyArray<Facet>).flatMap((facet) =>
    facets[facet].map((value) => `${facet}:${value}`),
  )
  const noun = mode === "flows" ? "specimens" : "screens"

  return (
    <header className="catalog-header">
      <div className="catalog-brand">
        <strong>Terminal Catalog</strong>
        <span>{resultCount} {noun}</span>
      </div>
      <nav className="catalog-tabs" aria-label="Catalog views">
        {modes.map(([value, title]) => (
          <button
            type="button"
            key={value}
            className={mode === value ? "active" : ""}
            aria-current={mode === value ? "page" : undefined}
            onClick={() => onMode(value)}
          >
            {title}
          </button>
        ))}
      </nav>
      <div className="catalog-tools">
        <div className="variant-switcher" aria-label="Capture variant">
          <button type="button" onClick={() => onVariant(-1)} aria-label="Previous variant">←</button>
          <span><strong>{variant.label}</strong><small>{variantPosition}/{catalog.variants.length}</small></span>
          <button type="button" onClick={() => onVariant(1)} aria-label="Next variant">→</button>
        </div>
        {mode !== "flows" ? (
          <FilterMenu
            label={mode === "screens" ? "Screens" : "UI Elements"}
            searchLabel={mode === "screens" ? "Search screen labels" : "Search UI elements"}
            groups={taxonomy}
            selected={taxonomyValues}
            counts={taxonomyCounts}
            onToggle={onTaxonomy}
            onClear={onClearTaxonomy}
          />
        ) : undefined}
        {mode !== "flows" ? (
          <FilterMenu
            label="Filters"
            searchLabel="Search filters"
            groups={facetGroups}
            selected={selectedFacets}
            onToggle={(encoded) => {
              const [facet, ...parts] = encoded.split(":")
              onFacet(facet as Facet, parts.join(":"))
            }}
            onClear={onClearFacets}
          />
        ) : undefined}
        <div className="catalog-search">
          <span aria-hidden="true">⌕</span>
          <input
            ref={searchRef}
            name="catalog-search"
            value={query}
            placeholder={`Search ${noun}`}
            aria-label={`Search ${noun}`}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return
              event.preventDefault()
              event.stopPropagation()
              event.currentTarget.blur()
              onClearSearch()
            }}
          />
          <kbd>/</kbd>
        </div>
        <button type="button" className="command-trigger" onClick={onOpenPalette}>
          Explore
          <kbd>⌘K</kbd>
        </button>
      </div>
    </header>
  )
}
