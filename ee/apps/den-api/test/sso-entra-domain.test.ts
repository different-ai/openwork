import { expect, test } from "bun:test"
import { isMicrosoftEntraManagedDomain } from "../src/sso-entra-domain.js"

const tenantId = "2b853de0-b14b-4433-90be-cced1b963647"

test("recognizes Microsoft Entra managed onmicrosoft.com SAML domains", () => {
  expect(isMicrosoftEntraManagedDomain({
    domain: "omaropenworklabs.onmicrosoft.com",
    issuer: `https://sts.windows.net/${tenantId}/`,
    entryPoint: `https://login.microsoftonline.com/${tenantId}/saml2`,
  })).toBe(true)
})

test("rejects mismatched Entra tenant URLs for managed domains", () => {
  expect(isMicrosoftEntraManagedDomain({
    domain: "omaropenworklabs.onmicrosoft.com",
    issuer: `https://sts.windows.net/${tenantId}/`,
    entryPoint: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/saml2",
  })).toBe(false)
})

test("keeps custom domains on DNS verification", () => {
  expect(isMicrosoftEntraManagedDomain({
    domain: "openworklabs.com",
    issuer: `https://sts.windows.net/${tenantId}/`,
    entryPoint: `https://login.microsoftonline.com/${tenantId}/saml2`,
  })).toBe(false)
})
