import { describe, expect, test } from "bun:test"
import {
  normalizeEntraTenantId,
  resolveTenantEndpointTemplate,
} from "../src/capability-sources/oauth-tenant.js"

describe("Entra tenant identifiers", () => {
  test("accepts canonical directory GUIDs without UUID version assumptions", () => {
    expect(normalizeEntraTenantId("12345678-1234-0234-7234-123456789ABC")).toBe("12345678-1234-0234-7234-123456789abc")
  })

  test("accepts verified-domain syntax and rejects shared authorities", () => {
    expect(normalizeEntraTenantId("Acme.ONMICROSOFT.com")).toBe("acme.onmicrosoft.com")
    expect(normalizeEntraTenantId("common")).toBeNull()
    expect(normalizeEntraTenantId("organizations")).toBeNull()
    expect(normalizeEntraTenantId("consumers")).toBeNull()
    expect(normalizeEntraTenantId("not a domain")).toBeNull()
  })

  test("requires tenant-scoped endpoint templates", () => {
    expect(resolveTenantEndpointTemplate(
      "https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token",
      "acme.onmicrosoft.com",
    )).toBe("https://login.microsoftonline.com/acme.onmicrosoft.com/oauth2/v2.0/token")
    expect(() => resolveTenantEndpointTemplate(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
      "acme.onmicrosoft.com",
    )).toThrow("{tenantId}")
  })
})
