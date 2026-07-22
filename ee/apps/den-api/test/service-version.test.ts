import { describe, expect, test } from "bun:test"
import { resolveDenServiceVersion } from "../src/service-version.js"

describe("Den service version", () => {
  test("prefers an explicitly configured release version", () => {
    expect(resolveDenServiceVersion({
      configuredVersion: "1.4.2",
      renderGitCommit: "0123456789abcdef0123456789abcdef01234567",
    })).toBe("1.4.2")
  })

  test("shows the short commit when Render only receives the Docker dev placeholder", () => {
    expect(resolveDenServiceVersion({
      configuredVersion: "dev",
      renderGitCommit: "0123456789abcdef0123456789abcdef01234567",
    })).toBe("commit 0123456")
  })

  test("formats an explicitly injected commit and retains a local fallback", () => {
    expect(resolveDenServiceVersion({
      configuredVersion: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
    })).toBe("commit abcdef0")
    expect(resolveDenServiceVersion({})).toBe("dev")
  })
})
