import { describe, expect, test } from "bun:test"
import { feedbackIssueUrl } from "../src/feedback"

describe("catalog feedback", () => {
  test("opens a prefilled issue for an exact capture", () => {
    const url = new URL(feedbackIssueUrl({
      title: "Skill picker",
      identifier: "skill-picker",
      deepLink: "https://catalog.kitlangton.dev/?screen=skill-picker&set=baseline",
      variant: "baseline",
    }))

    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/anomalyco/opencode-drive/issues/new")
    expect(url.searchParams.get("title")).toBe("[Catalog feedback] Skill picker")
    expect(url.searchParams.get("body")).toContain("`skill-picker`")
    expect(url.searchParams.get("body")).toContain("screen=skill-picker&set=baseline")
  })
})
