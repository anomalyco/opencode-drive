import { describe, expect, test } from "bun:test"
import wrangler from "../wrangler.jsonc"
import worker, { assetPath, metaTags } from "../worker"

const catalog = {
  variants: [
    { id: "opencode", label: "Opencode" },
    { id: "tokyonight", label: "Tokyo Night" },
  ],
  screens: [
    {
      id: "home",
      title: "Home",
      summary: "",
      frames: [{ variantId: "opencode" }, { variantId: "tokyonight" }],
    },
  ],
}

describe("catalog worker", () => {
  test("asks search engines not to index anything it serves", async () => {
    const env = { ASSETS: { fetch: async () => Response.redirect("https://dev.opencode.ai/lab/catalog/", 307) } }
    const responses = await Promise.all(
      ["/lab/catalog/captures/x.png", "/lab/catalogue"].map((path) =>
        worker.fetch(new Request(`https://dev.opencode.ai${path}`), env),
      ),
    )
    expect(responses.map((response) => response.headers.get("X-Robots-Tag"))).toEqual([
      "noindex, nofollow",
      "noindex, nofollow",
    ])
  })

  test("serves the app shell for catalog routes", () => {
    expect(assetPath("/lab/catalog")).toBe("/index.html")
    expect(assetPath("/lab/catalog/")).toBe("/index.html")
    expect(assetPath("/lab/catalog/deep-link")).toBe("/index.html")
    expect(assetPath("/lab/catalogue")).toBeUndefined()
  })

  test("strips the catalog prefix from assets", () => {
    expect(assetPath("/lab/catalog/catalog.json")).toBe("/catalog.json")
    expect(assetPath("/lab/catalog/captures/opencode/home.frame.json")).toBe("/captures/opencode/home.frame.json")
  })

  test("leaves HTML routing to the worker", () => {
    expect(wrangler.assets.html_handling).toBe("none")
  })

  test("injects a per-capture Open Graph card for deep links", () => {
    const tags = metaTags(new URL("https://dev.opencode.ai/lab/catalog?screen=home&set=tokyonight"), catalog)
    expect(tags).toContain('content="Home — OpenCode Terminal Catalog"')
    expect(tags).toContain('content="https://dev.opencode.ai/lab/catalog/og/home--tokyonight.png"')
    expect(tags).toContain("Tokyo Night theme")
    expect(tags).toContain('name="twitter:card" content="summary_large_image"')
  })

  test("defaults the theme to the first variant", () => {
    const tags = metaTags(new URL("https://dev.opencode.ai/lab/catalog?screen=home"), catalog)
    expect(tags).toContain('content="https://dev.opencode.ai/lab/catalog/og/home--opencode.png"')
  })

  test("falls back to the default card for unknown or missing captures", () => {
    for (const search of ["", "?screen=missing", "?screen=home&set=missing"]) {
      const tags = metaTags(new URL(`https://dev.opencode.ai/lab/catalog${search}`), catalog)
      expect(tags).toContain('content="https://dev.opencode.ai/lab/catalog/og/default.png"')
      expect(tags).toContain('content="OpenCode Terminal Catalog"')
    }
  })
})
