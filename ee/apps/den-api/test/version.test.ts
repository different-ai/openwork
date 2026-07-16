import { describe, expect, test } from "bun:test"

import { resolveDenApiVersion } from "../src/version.js"

describe("den-api runtime version", () => {
  test("reports the supplied release or revision", () => {
    expect(resolveDenApiVersion(" 0.17.31 ")).toBe("0.17.31")
    expect(resolveDenApiVersion("abc123def456")).toBe("abc123def456")
  })

  test("identifies local source runs as development builds", () => {
    expect(resolveDenApiVersion(undefined)).toBe("dev")
    expect(resolveDenApiVersion("  ")).toBe("dev")
  })
})
