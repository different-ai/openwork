import { moduleDisabledErrorSchema } from "@openwork/license-contracts/errors"
import type { ModuleOffState } from "@openwork/license-contracts/resolver"
import { describe, expect, test } from "vitest"
import { moduleDisabledResponse } from "./module-off-response"

const states: ModuleOffState[] = [
  { state: "off", reason: "not_on_deployment" },
  { state: "off", reason: "not_available", detail: "gateway_disabled" },
  { state: "off", reason: "not_entitled" },
  { state: "off", reason: "license_expired" },
  { state: "off", reason: "disabled_by_org" },
  { state: "off", reason: "requires", requires: "connect" },
]

describe("moduleDisabledResponse (§8.2a)", () => {
  test.each(states.flatMap((state) => [true, false].map((desktopFacing) => ({ state, desktopFacing }))))(
    "$state.reason desktopFacing=$desktopFacing",
    async ({ state, desktopFacing }) => {
      const response = moduleDisabledResponse({ moduleId: "mcpApps", state, desktopFacing })
      expect(response.status).toBe(desktopFacing ? 404 : 403)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("content-type")).toBe("application/json")
      expect(response.headers.get("X-OpenWork-Module")).toBe("mcpApps")
      expect(response.headers.get("X-OpenWork-Module-Reason")).toBe(state.reason)
      const body = moduleDisabledErrorSchema.parse(await response.json())
      expect(body).toMatchObject({ module: "mcpApps", reason: state.reason, requires: state.reason === "requires" ? "connect" : null })
    },
  )

  test("a restricted denial reads as license_expired", async () => {
    const response = moduleDisabledResponse({ moduleId: "enterpriseAuth.sso", state: { state: "restricted", denied: true }, desktopFacing: false })
    expect(response.status).toBe(403)
    expect(moduleDisabledErrorSchema.parse(await response.json()).reason).toBe("license_expired")
  })
})
