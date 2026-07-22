import { describe, expect, test } from "bun:test"
import { isOrganizationSsoReady } from "../src/sso-readiness.js"

describe("isOrganizationSsoReady", () => {
  test("requires both an enabled connection and its provider record", () => {
    expect(isOrganizationSsoReady({ connection: null, providerExists: false })).toBe(false)
    expect(isOrganizationSsoReady({ connection: { status: "disabled" }, providerExists: true })).toBe(false)
    expect(isOrganizationSsoReady({ connection: { status: "enabled" }, providerExists: false })).toBe(false)
    expect(isOrganizationSsoReady({ connection: { status: "enabled" }, providerExists: true })).toBe(true)
  })
})
