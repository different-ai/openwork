import { expect, test } from "bun:test"
import { isMicrosoftEntraManagedDomain } from "../src/sso-entra-domain.js"

const tenantId = "2b853de0-b14b-4433-90be-cced1b963647"

test("recognizes Microsoft Entra issuer URLs", () => {
  expect(isMicrosoftEntraManagedDomain({
    domain: "omaropenworklabs.onmicrosoft.com",
    issuer: `https://sts.windows.net/${tenantId}/`,
    entryPoint: `https://login.microsoftonline.com/${tenantId}/saml2`,
  })).toBe(true)
})

test("ignores mismatched entry point tenant URLs", () => {
  expect(isMicrosoftEntraManagedDomain({
    domain: "omaropenworklabs.onmicrosoft.com",
    issuer: `https://sts.windows.net/${tenantId}/`,
    entryPoint: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/saml2",
  })).toBe(true)
})

test("ignores custom domains for Microsoft Entra issuer URLs", () => {
  expect(isMicrosoftEntraManagedDomain({
    domain: "openworklabs.com",
    issuer: `https://sts.windows.net/${tenantId}/`,
    entryPoint: `https://login.microsoftonline.com/${tenantId}/saml2`,
  })).toBe(true)
})

test("rejects non-Microsoft issuer URLs", () => {
  expect(isMicrosoftEntraManagedDomain({
    domain: "omaropenworklabs.onmicrosoft.com",
    issuer: `https://idp.example.com/${tenantId}/`,
    entryPoint: `https://login.microsoftonline.com/${tenantId}/saml2`,
  })).toBe(false)
})

test("rejects Microsoft issuer URLs without tenant UUIDs", () => {
  expect(isMicrosoftEntraManagedDomain({
    domain: "omaropenworklabs.onmicrosoft.com",
    issuer: "https://login.microsoftonline.com/common/v2.0",
    entryPoint: `https://login.microsoftonline.com/${tenantId}/saml2`,
  })).toBe(false)
})
