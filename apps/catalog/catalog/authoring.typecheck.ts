import { defineFlows, defineScreens, defineTaxonomies } from "./dsl"

const taxonomies = defineTaxonomies({
  screenLabels: {
    session: { label: "Session", items: { "session-list": "Session list" } },
  },
  uiElements: {
    selection: { label: "Selection", items: { picker: "Picker" } },
  },
})

const screens = defineScreens(taxonomies, {
  "session-picker": {
    title: "Session picker",
    category: "session",
    screenLabels: ["session-list"],
    uiElements: ["picker"],
    surfaces: "modal",
    patterns: "picker",
    features: "session",
    states: "default",
  },
})

// @ts-expect-error Unknown screen labels are rejected at the authoring site.
defineScreens(taxonomies, {
  invalid: {
    title: "Invalid",
    category: "session",
    screenLabels: ["session-lits"],
    uiElements: ["picker"],
    surfaces: "modal",
    patterns: "picker",
    features: "session",
    states: "default",
  },
})

defineScreens(taxonomies, {
  invalid: {
    title: "Invalid",
    category: "session",
    screenLabels: ["session-list"],
    uiElements: ["picker"],
    // @ts-expect-error Closed facet vocabularies reject typo-created filters.
    surfaces: "modla",
    patterns: "picker",
    features: "session",
    states: "default",
  },
})

// @ts-expect-error Flow steps can only reference authored screen keys.
defineFlows(screens, {
  session: {
    label: "Session",
    flows: {
      invalid: {
        title: "Invalid flow",
        description: "Type-level reference check.",
        steps: [
          {
            capture: "session-pikcer",
            title: "Open the picker",
          },
        ],
      },
    },
  },
})
