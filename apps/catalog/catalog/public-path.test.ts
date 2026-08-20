import { describe, expect, test } from "bun:test"
import { publicFilePath } from "./public-path"

describe("catalog public paths", () => {
  const root = "/catalog/public"

  test("resolves nested public assets", () => {
    expect(publicFilePath(root, "/captures/opencode/home.frame.json")).toBe(
      "/catalog/public/captures/opencode/home.frame.json",
    )
  })

  test("rejects encoded traversal and malformed paths", () => {
    expect(publicFilePath(root, "/%252e%252e%2fpackage.json")).toBeUndefined()
    expect(publicFilePath(root, "/../package.json")).toBeUndefined()
    expect(publicFilePath(root, "/%zz")).toBeUndefined()
  })
})
