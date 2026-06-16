import { describe, expect, test } from "bun:test"
import { validateSamlResponsePolicy } from "../src/sso-saml-response-policy.js"

const expectedAudience = "https://openwork.example.com/saml/metadata"
const expectedAcsUrl = "https://openwork.example.com/api/auth/sso/saml2/sp/acs/openwork-sso-org_123"

describe("SAML response policy", () => {
  test("accepts matching audience, destination, recipient, and assertion ID", () => {
    expect(validateSamlResponsePolicy({
      samlResponse: samlResponse(),
      expectedAudience,
      expectedRecipient: expectedAcsUrl,
      expectedDestination: expectedAcsUrl,
    })).toEqual({ ok: true })
  })

  test("rejects missing assertion IDs so replay protection can fail closed", () => {
    const result = validateSamlResponsePolicy({
      samlResponse: samlResponse({ assertionId: null }),
      expectedAudience,
      expectedRecipient: expectedAcsUrl,
      expectedDestination: expectedAcsUrl,
    })

    expect(result).toMatchObject({ ok: false, code: "missing_assertion_id" })
  })

  test("rejects responses for another audience", () => {
    const result = validateSamlResponsePolicy({
      samlResponse: samlResponse({ audience: "https://other-sp.example.com/saml/metadata" }),
      expectedAudience,
      expectedRecipient: expectedAcsUrl,
      expectedDestination: expectedAcsUrl,
    })

    expect(result).toMatchObject({ ok: false, code: "invalid_audience" })
  })

  test("rejects responses posted to another destination", () => {
    const result = validateSamlResponsePolicy({
      samlResponse: samlResponse({ destination: "https://evil.example.com/acs" }),
      expectedAudience,
      expectedRecipient: expectedAcsUrl,
      expectedDestination: expectedAcsUrl,
    })

    expect(result).toMatchObject({ ok: false, code: "invalid_destination" })
  })

  test("rejects assertions with another recipient", () => {
    const result = validateSamlResponsePolicy({
      samlResponse: samlResponse({ recipient: "https://evil.example.com/acs" }),
      expectedAudience,
      expectedRecipient: expectedAcsUrl,
      expectedDestination: expectedAcsUrl,
    })

    expect(result).toMatchObject({ ok: false, code: "invalid_recipient" })
  })
})

function samlResponse(overrides: {
  assertionId?: string | null
  audience?: string
  destination?: string
  recipient?: string
} = {}) {
  const assertionId = overrides.assertionId === undefined ? "assertion-123" : overrides.assertionId
  const assertionIdAttribute = assertionId ? `ID="${assertionId}"` : ""
  const audience = overrides.audience ?? expectedAudience
  const destination = overrides.destination ?? expectedAcsUrl
  const recipient = overrides.recipient ?? expectedAcsUrl
  const xml = `
    <samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="response-123" Version="2.0" IssueInstant="2026-06-15T00:00:00Z" Destination="${destination}">
      <saml:Issuer>https://idp.example.com</saml:Issuer>
      <samlp:Status>
        <samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success" />
      </samlp:Status>
      <saml:Assertion ${assertionIdAttribute} Version="2.0" IssueInstant="2026-06-15T00:00:00Z">
        <saml:Issuer>https://idp.example.com</saml:Issuer>
        <saml:Subject>
          <saml:NameID>user@example.com</saml:NameID>
          <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
            <saml:SubjectConfirmationData Recipient="${recipient}" NotOnOrAfter="2026-06-15T00:05:00Z" />
          </saml:SubjectConfirmation>
        </saml:Subject>
        <saml:Conditions NotBefore="2026-06-14T23:55:00Z" NotOnOrAfter="2026-06-15T00:05:00Z">
          <saml:AudienceRestriction>
            <saml:Audience>${audience}</saml:Audience>
          </saml:AudienceRestriction>
        </saml:Conditions>
      </saml:Assertion>
    </samlp:Response>
  `

  return Buffer.from(xml, "utf8").toString("base64")
}
