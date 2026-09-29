import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { withSsoEmailDomainProof } from "../src/sso-email-domain-proof.js"

let createRevision: typeof import("../src/sso-test-lifecycle.js").createSsoConfigRevision
beforeAll(async () => {
  mock.module("../src/db.js", () => ({ db: {} }))
  mock.module("../src/env.js", () => ({ env: { betterAuthSecret: "synthetic-config-revision-secret-only-for-tests" } }))
  createRevision = (await import("../src/sso-test-lifecycle.js")).createSsoConfigRevision
})
afterAll(() => mock.restore())

for (const kind of ["oidc", "saml"]) {
  test(`${kind}: revisions ignore database and unrelated metadata outside the declared security fields`, () => {
    const settings = {
      kind, issuer: "https://idp.example.test", domain: "example.test",
      oidcConfig: kind === "oidc" ? JSON.stringify({ clientId: "client" }) : null,
      samlConfig: kind === "saml" ? JSON.stringify({ cert: "certificate" }) : null,
    }
    const beforeInsert = { ...settings, id: "provider-row", providerId: "provider", organizationId: "organization", userId: "administrator", domainVerified: false }
    const fromDatabase = {
      ...beforeInsert, domainVerified: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      description: "Unrelated metadata", status: "enabled",
    }
    expect(createRevision(beforeInsert)).toBe(createRevision(settings))
    expect(createRevision(fromDatabase)).toBe(createRevision(beforeInsert))
    const metadataOnlyUpdate = { ...fromDatabase, updatedAt: new Date("2026-03-01T00:00:00.000Z") }
    expect(createRevision(metadataOnlyUpdate)).toBe(createRevision(settings))
  })

  test(`${kind}: DNS provenance does not invalidate a successful configuration test`, () => {
    const config = JSON.stringify({ clientId: "client", cert: "certificate", mapping: { email: "mailbox" } })
    const settings = {
      kind, issuer: "https://idp.example.test", domain: "example.test",
      oidcConfig: kind === "oidc" ? config : null, samlConfig: kind === "saml" ? config : null,
    }
    const proof = {
      version: 1, organizationId: "organization", providerId: "provider", domain: "example.test",
      method: "dns-txt", verifiedAt: "2026-01-01T00:00:00.000Z",
    } satisfies Parameters<typeof withSsoEmailDomainProof>[1]
    const stamped = withSsoEmailDomainProof(config, proof)
    const withProof = { ...settings, oidcConfig: kind === "oidc" ? stamped : null, samlConfig: kind === "saml" ? stamped : null }
    expect(createRevision(withProof)).toBe(createRevision(settings))
    const formatted = JSON.stringify({ clientId: "client", cert: "certificate", mapping: { email: "mailbox" } }, null, 2)
    expect(createRevision({ ...settings, oidcConfig: kind === "oidc" ? formatted : null, samlConfig: kind === "saml" ? formatted : null })).toBe(createRevision(withProof))
    const renewed = withSsoEmailDomainProof(config, { ...proof, verifiedAt: "2026-02-01T00:00:00.000Z" })
    expect(createRevision({ ...settings, oidcConfig: kind === "oidc" ? renewed : null, samlConfig: kind === "saml" ? renewed : null })).toBe(createRevision(settings))
    const changed = JSON.stringify({ clientId: "replacement", cert: "replacement", mapping: { email: "other" } })
    expect(createRevision({ ...settings, oidcConfig: kind === "oidc" ? changed : null, samlConfig: kind === "saml" ? changed : null })).not.toBe(createRevision(settings))
    expect(createRevision({ ...settings, domain: "other.test" })).not.toBe(createRevision(settings))
    expect(createRevision({ ...settings, issuer: "https://replacement.example.test" })).not.toBe(createRevision(settings))
  })
}
