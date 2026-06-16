import { XMLParser } from "fast-xml-parser"

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  textNodeName: "#text",
  trimValues: true,
})

export type SamlResponsePolicyInput = {
  samlResponse: string
  expectedAudience: string
  expectedRecipient: string
  expectedDestination: string
}

type SamlResponsePolicyFailure = { ok: false; code: string; message: string }

export type SamlResponsePolicyResult = { ok: true } | SamlResponsePolicyFailure

export function validateSamlResponsePolicy(input: SamlResponsePolicyInput): SamlResponsePolicyResult {
  const parsed = parseSamlResponse(input.samlResponse)
  if (!parsed.ok) {
    return parsed
  }

  const response = firstRecordChild(parsed.document, "Response")
  if (!response) {
    return invalid("missing_response", "SAML response XML is missing a Response element.")
  }

  const destination = stringAttribute(response, "Destination")
  if (!sameUrl(destination, input.expectedDestination)) {
    return invalid("invalid_destination", "SAML response Destination does not match the configured ACS URL.")
  }

  const assertions = recordChildren(response, "Assertion")
  if (assertions.length !== 1) {
    return invalid("invalid_assertion_count", "SAML response must contain exactly one plaintext Assertion.")
  }

  const assertion = assertions[0]
  const assertionId = stringAttribute(assertion, "ID")
  if (!assertionId) {
    return invalid("missing_assertion_id", "SAML assertion is missing an ID required for replay protection.")
  }

  const audiences = audienceValues(assertion)
  if (!audiences.some((audience) => audience === input.expectedAudience)) {
    return invalid("invalid_audience", "SAML assertion AudienceRestriction does not include the configured SP audience.")
  }

  const recipients = recipientValues(assertion)
  if (recipients.length === 0) {
    return invalid("missing_recipient", "SAML assertion is missing SubjectConfirmationData Recipient.")
  }

  if (!recipients.every((recipient) => sameUrl(recipient, input.expectedRecipient))) {
    return invalid("invalid_recipient", "SAML assertion Recipient does not match the configured ACS URL.")
  }

  return { ok: true }
}

function parseSamlResponse(samlResponse: string): { ok: true; document: Record<string, unknown> } | { ok: false; code: string; message: string } {
  const xml = Buffer.from(samlResponse.replace(/\s+/g, ""), "base64").toString("utf8")
  if (!xml.includes("<")) {
    return invalid("invalid_encoding", "SAMLResponse is not valid base64-encoded XML.")
  }

  try {
    const parsed: unknown = parser.parse(xml)
    if (!isRecord(parsed)) {
      return invalid("invalid_xml", "SAMLResponse XML did not parse to an object.")
    }
    return { ok: true, document: parsed }
  } catch {
    return invalid("invalid_xml", "SAMLResponse XML could not be parsed.")
  }
}

function audienceValues(assertion: Record<string, unknown>) {
  return recordChildren(assertion, "Conditions")
    .flatMap((conditions) => recordChildren(conditions, "AudienceRestriction"))
    .flatMap((restriction) => valuesForKey(restriction, "Audience"))
    .map(textValue)
    .filter(isNonEmptyString)
}

function recipientValues(assertion: Record<string, unknown>) {
  return recordChildren(assertion, "Subject")
    .flatMap((subject) => recordChildren(subject, "SubjectConfirmation"))
    .flatMap((confirmation) => recordChildren(confirmation, "SubjectConfirmationData"))
    .map((data) => stringAttribute(data, "Recipient"))
    .filter(isNonEmptyString)
}

function firstRecordChild(record: Record<string, unknown>, key: string) {
  return recordChildren(record, key)[0] ?? null
}

function recordChildren(record: Record<string, unknown>, key: string) {
  return valuesForKey(record, key).filter(isRecord)
}

function valuesForKey(record: Record<string, unknown>, key: string) {
  const value = record[key]
  if (Array.isArray(value)) {
    return value
  }
  return value === undefined ? [] : [value]
}

function stringAttribute(record: Record<string, unknown>, name: string) {
  const value = record[`@_${name}`]
  return typeof value === "string" && value.length > 0 ? value : null
}

function textValue(value: unknown) {
  if (typeof value === "string") {
    return value
  }
  if (!isRecord(value)) {
    return null
  }
  const text = value["#text"]
  return typeof text === "string" && text.length > 0 ? text : null
}

function sameUrl(value: string | null, expected: string) {
  const normalizedValue = normalizeUrl(value)
  const normalizedExpected = normalizeUrl(expected)
  return normalizedValue !== null && normalizedExpected !== null && normalizedValue === normalizedExpected
}

function normalizeUrl(value: string | null) {
  if (!value) {
    return null
  }

  try {
    return new URL(value).href
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: string | null): value is string {
  return typeof value === "string" && value.length > 0
}

function invalid(code: string, message: string): SamlResponsePolicyFailure {
  return { ok: false, code, message }
}
