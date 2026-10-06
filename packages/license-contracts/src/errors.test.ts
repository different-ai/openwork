import { describe, expect, test } from "vitest"
import {
  buildModuleDisabledBody,
  licenseUnavailableErrorSchema,
  MODULE_HEADER,
  MODULE_REASON_HEADER,
  moduleDisabledErrorClientSchema,
  moduleDisabledErrorSchema,
  moduleDisabledHeaders,
  moduleDisabledStatus,
} from "./errors"
import type { ModuleOffState } from "./resolver"

const cases: Array<[ModuleOffState, string, string, string | null]> = [
  [{ state: "off", reason: "not_entitled" }, "contact_support", "Usage limits isn't included in your organization's plan. Contact support to upgrade.", null],
  [{ state: "off", reason: "license_expired" }, "contact_support", "Usage limits is limited because your license has expired. Contact support to renew.", null],
  [{ state: "off", reason: "disabled_by_org" }, "ask_admin", "An administrator turned off Usage limits for your organization.", null],
  [{ state: "off", reason: "requires", requires: "ai.gateway" }, "none", "Usage limits needs AI Gateway, which is turned off.", "ai.gateway"],
  [{ state: "off", reason: "not_available", detail: "unknown" }, "none", "Usage limits isn't set up on this deployment.", null],
  [{ state: "off", reason: "not_on_deployment" }, "none", "Usage limits isn't part of this deployment.", null],
]

describe("buildModuleDisabledBody", () => {
  test.each(cases)("%o", (state, action, message, requires) => {
    const body = buildModuleDisabledBody({ moduleId: "ai.gateway.usageLimits", state })
    expect(moduleDisabledErrorSchema.parse(body)).toEqual(body)
    expect(body).toEqual({ error: "module_disabled", module: "ai.gateway.usageLimits", reason: state.reason, requires, message, action })
  })

  test("a restricted denial reads as license_expired", () => {
    const body = buildModuleDisabledBody({ moduleId: "org.auth.sso", state: { state: "restricted", denied: true } })
    expect(body).toMatchObject({ reason: "license_expired", requires: null, action: "contact_support" })
    expect(body.message).toBe("Single sign-on is limited because your license has expired. Contact support to renew.")
  })
})

describe("headers and status", () => {
  test("headers carry the module and reason", () => {
    const body = buildModuleDisabledBody({ moduleId: "org.members.teams", state: { state: "off", reason: "disabled_by_org" } })
    expect(moduleDisabledHeaders(body)).toEqual({ [MODULE_HEADER]: "org.members.teams", [MODULE_REASON_HEADER]: "disabled_by_org" })
    expect(MODULE_HEADER).toBe("X-OpenWork-Module")
    expect(MODULE_REASON_HEADER).toBe("X-OpenWork-Module-Reason")
  })

  test("404 on desktop-facing routes, 403 elsewhere", () => {
    expect(moduleDisabledStatus({ desktopFacing: true })).toBe(404)
    expect(moduleDisabledStatus({ desktopFacing: false })).toBe(403)
  })
})

describe("schemas", () => {
  test("the server schema is strict about reasons and actions", () => {
    const body = { error: "module_disabled", module: "futureModule", reason: "quota_exceeded", requires: null, message: "x", action: "upgrade" }
    expect(moduleDisabledErrorSchema.safeParse(body).success).toBe(false)
    expect(moduleDisabledErrorSchema.safeParse({ ...body, reason: "not_entitled", action: "none" }).success).toBe(true)
  })

  test("the client schema accepts future reasons, actions and ids", () => {
    const body = { error: "module_disabled", module: "futureModule", reason: "quota_exceeded", message: "x", action: "upgrade", operation: "configure" }
    expect(moduleDisabledErrorClientSchema.safeParse(body).success).toBe(true)
  })

  test("license unavailable body", () => {
    expect(licenseUnavailableErrorSchema.safeParse({ error: "license_unavailable", message: "Try again later." }).success).toBe(true)
  })
})
