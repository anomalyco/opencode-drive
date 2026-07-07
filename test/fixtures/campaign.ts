import { defineCampaign } from "../../src/experimental/campaign-api.js"

export default defineCampaign({
  count: 2,
  generate: ({ index, seed }) => ({ index, seed, text: `case-${index}-${seed}` }),
  run: async ({ flow, ui }) => {
    await ui.typeText(flow.text)
    const state = await ui.state()
    if (!state.screen.includes(flow.text)) throw new Error(`${flow.text} did not render`)
    return { screen: state.screen }
  },
})
