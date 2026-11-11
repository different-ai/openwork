import assert from "node:assert/strict"
import { test } from "node:test"
import { validateSamlResponsePolicy } from "../src/sso-saml-response-policy.js"

const acsUrl = "https://den.example.test/api/auth/sso/saml2/sp/acs/provider-1"
const audience = "https://den.example.test/api/auth/sso/saml2/sp/metadata?providerId=provider-1"

function samlResponse(options: { destination?: string; recipient?: string; audience?: string; assertions?: number; assertionId?: string } = {}) {
  const assertion = `
    <saml:Assertion ID="${options.assertionId ?? "assertion-1"}" Version="2.0">
      <saml:Subject>
        <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
          <saml:SubjectConfirmationData Recipient="${options.recipient ?? acsUrl}" />
        </saml:SubjectConfirmation>
      </saml:Subject>
      <saml:Conditions>
        <saml:AudienceRestriction>
          <saml:Audience>${options.audience ?? audience}</saml:Audience>
        </saml:AudienceRestriction>
      </saml:Conditions>
    </saml:Assertion>`
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="response-1" Destination="${options.destination ?? acsUrl}">
      ${assertion.repeat(options.assertions ?? 1)}
    </samlp:Response>`
  return Buffer.from(xml, "utf8").toString("base64")
}

function check(response: string) {
  return validateSamlResponsePolicy({ samlResponse: response, expectedAudience: audience, expectedAcsUrls: [acsUrl] })
}

test("a SAML response for this ACS URL and audience passes", () => {
  assert.deepEqual(check(samlResponse()), { ok: true })
})

test("SAML responses for another destination, recipient or audience are refused", () => {
  assert.equal(code(check(samlResponse({ destination: "https://other.example.test/acs" }))), "invalid_destination")
  assert.equal(code(check(samlResponse({ recipient: "https://other.example.test/acs" }))), "invalid_recipient")
  assert.equal(code(check(samlResponse({ audience: "https://other.example.test/metadata" }))), "invalid_audience")
})

test("SAML responses without exactly one identified assertion are refused", () => {
  assert.equal(code(check(samlResponse({ assertions: 2 }))), "invalid_assertion_count")
  assert.equal(code(check(samlResponse({ assertionId: "" }))), "missing_assertion_id")
})

test("a SAMLResponse that is not base64 XML is refused", () => {
  assert.equal(code(check("not-xml")), "invalid_encoding")
})

function code(result: ReturnType<typeof validateSamlResponsePolicy>) {
  return result.ok ? "ok" : result.code
}
