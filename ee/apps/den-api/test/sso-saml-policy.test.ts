import { expect, test } from "bun:test"
import {
  ORGANIZATION_SAML_ALLOW_IDP_INITIATED,
  ORGANIZATION_SAML_DEPRECATED_ALGORITHM_BEHAVIOR,
  ORGANIZATION_SAML_REQUIRE_TIMESTAMPS,
  ORGANIZATION_SAML_WANT_ASSERTIONS_SIGNED,
} from "../src/sso-saml-policy.js"

test("organization SAML registrations require signed assertions", () => {
  expect(ORGANIZATION_SAML_WANT_ASSERTIONS_SIGNED).toBe(true)
})

test("organization SAML runtime rejects unsolicited or weak responses", () => {
  expect(ORGANIZATION_SAML_ALLOW_IDP_INITIATED).toBe(false)
  expect(ORGANIZATION_SAML_REQUIRE_TIMESTAMPS).toBe(true)
  expect(ORGANIZATION_SAML_DEPRECATED_ALGORITHM_BEHAVIOR).toBe("reject")
})
