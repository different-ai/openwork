import { expect, test } from "bun:test"
import { DEN_ACCOUNT_CONFIG } from "../src/account-linking-policy.js"

test("SSO can implicitly link a verified-domain provider to an existing unverified Den user", () => {
  expect(DEN_ACCOUNT_CONFIG.accountLinking.enabled).toBe(true)
  expect(DEN_ACCOUNT_CONFIG.accountLinking.requireLocalEmailVerified).toBe(false)
})
