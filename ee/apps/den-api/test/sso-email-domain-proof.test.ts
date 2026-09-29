import assert from "node:assert/strict"
import { test } from "node:test"
import { isSsoEmailDomainTrusted, readSsoEmailDomainProof, stripSsoEmailDomainProof, withSsoEmailDomainProof, type SsoEmailDomainProvider } from "../src/sso-email-domain-proof.js"

const provider: SsoEmailDomainProvider = {
  issuer: "https://idp.example.test", domain: "example.test", providerId: "provider-one",
  organizationId: "organization-one", domainVerified: true,
  oidcConfig: { openworkEmailDomainProof: {
    version: 1, organizationId: "organization-one", providerId: "provider-one",
    domain: "example.test", method: "dns-txt", verifiedAt: "2026-01-01T00:00:00.000Z",
  } },
}

test("DNS provenance authorizes only its bound provider and exact email domain", () => {
  assert.equal(isSsoEmailDomainTrusted(provider, "member@example.test", { protocol: "oidc", allowDevelopment: false }), true)
  assert.equal(isSsoEmailDomainTrusted({ ...provider, oidcConfig: {} }, "member@example.test", { protocol: "oidc", allowDevelopment: false }), false)
  assert.equal(isSsoEmailDomainTrusted(provider, "member@sub.example.test", { protocol: "oidc", allowDevelopment: false }), false)
})

for (const protocol of ["oidc", "saml"] satisfies Array<"oidc" | "saml">) {
  const configured = { ...provider, oidcConfig: JSON.stringify(provider.oidcConfig), samlConfig: provider.oidcConfig }
  test(`${protocol}: genuine proof supports normalized email/domain but no wildcard, list, URL or malformed mailbox`, () => {
    assert.equal(isSsoEmailDomainTrusted({ ...configured, domain: " EXAMPLE.TEST " }, " Member@EXAMPLE.TEST ", { protocol, allowDevelopment: false }), true)
    for (const email of ["member@outside.test", "member@sub.example.test", "member@example.test@outside.test", "@example.test", "member @example.test"]) {
      assert.equal(isSsoEmailDomainTrusted(configured, email, { protocol, allowDevelopment: false }), false, email)
    }
    for (const domain of ["*.example.test", "example.test,other.test", "https://example.test", "example.test/path", "example.test."]) {
      assert.equal(isSsoEmailDomainTrusted({ ...configured, domain }, "member@example.test", { protocol, allowDevelopment: false }), false, domain)
    }
  })

  test(`${protocol}: legacy flags, issuer changes and copied markers never confer authority`, () => {
    for (const changed of [
      { domainVerified: false }, { domainVerified: null }, { organizationId: "another-org" },
      { providerId: "another-provider" }, { organizationId: null },
      { oidcConfig: {}, samlConfig: {} }, { oidcConfig: "{", samlConfig: "{" },
      { oidcConfig: [], samlConfig: [] },
    ]) {
      assert.equal(isSsoEmailDomainTrusted({ ...configured, ...changed }, "member@example.test", { protocol, allowDevelopment: false }), false)
    }
    const unproven = { ...configured, oidcConfig: {}, samlConfig: {} }
    for (const issuer of ["https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0", "https://replacement.example.test"]) {
      assert.equal(isSsoEmailDomainTrusted({ ...unproven, issuer }, "member@example.test", { protocol, allowDevelopment: false }), false)
    }
    for (const override of [{ version: 2 }, { domain: "EXAMPLE.TEST" }, { method: "issuer" }, { verifiedAt: "not-a-date" }]) {
      const proof = readSsoEmailDomainProof(configured, { protocol, allowDevelopment: false })
      const config = { openworkEmailDomainProof: { ...proof, ...override } }
      assert.equal(isSsoEmailDomainTrusted({ ...configured, oidcConfig: config, samlConfig: config }, "member@example.test", { protocol, allowDevelopment: false }), false)
    }
  })

  test(`${protocol}: development proof is accepted only in development with a current loopback issuer`, () => {
    const proof = readSsoEmailDomainProof(configured, { protocol, allowDevelopment: false })
    assert.ok(proof)
    const config = withSsoEmailDomainProof({}, { ...proof, method: "development" })
    const development = { ...configured, issuer: "http://127.0.0.1:3001", oidcConfig: config, samlConfig: config }
    assert.equal(isSsoEmailDomainTrusted(development, "member@example.test", { protocol, allowDevelopment: true }), true)
    assert.equal(isSsoEmailDomainTrusted(development, "member@example.test", { protocol, allowDevelopment: false }), false)
    assert.equal(isSsoEmailDomainTrusted({ ...development, issuer: "https://replacement.example.test" }, "member@example.test", { protocol, allowDevelopment: true }), false)
  })
}

test("a loopback SAML service provider does not make a remote IdP eligible for development proof", () => {
  const proof = readSsoEmailDomainProof(provider, { protocol: "oidc", allowDevelopment: false })
  assert.ok(proof)
  const samlConfig = withSsoEmailDomainProof({ idpMetadata: { entityID: "https://remote-idp.example.test" } }, { ...proof, method: "development" })
  assert.equal(isSsoEmailDomainTrusted({ ...provider, issuer: "http://localhost:3000", samlConfig }, "member@example.test", { protocol: "saml", allowDevelopment: true }), false)
})

test("proof metadata is excluded without changing security configuration", () => {
  const config = JSON.stringify({ clientId: "client", mapping: { email: "mailbox" } })
  const proof = readSsoEmailDomainProof(provider, { protocol: "oidc", allowDevelopment: false })
  assert.ok(proof)
  assert.equal(stripSsoEmailDomainProof(withSsoEmailDomainProof(config, proof)), config)
  assert.equal(stripSsoEmailDomainProof(config), config)
  assert.equal(stripSsoEmailDomainProof(null), null)
})
