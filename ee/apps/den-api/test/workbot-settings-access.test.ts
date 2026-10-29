import assert from "node:assert/strict"
import { test } from "node:test"
import type { PermissionKey } from "@openwork/types/den/permissions"
import { getOrgAccessFlags, getWorkbotSettingsRoute } from "../../den-web/app/(den)/_lib/den-org.ts"
import { adminRouteLockedMessage, canOpenAdminRoute } from "../../den-web/app/(den)/dashboard/_lib/admin-route-access.ts"

const cases: { label: string; permissions: PermissionKey[]; read: boolean; manage: boolean }[] = [
  { label: "view-only", permissions: ["inference.view"], read: true, manage: false },
  { label: "manage-only", permissions: ["inference.manage"], read: true, manage: true },
  { label: "neither", permissions: [], read: false, manage: false },
  { label: "unrelated permission", permissions: ["plugins.import"], read: false, manage: false },
]

for (const role of cases) {
  test(`${role.label} member has the matching Workbot settings route and write access`, () => {
    const access = getOrgAccessFlags("member", false, role.permissions)
    assert.equal(canOpenAdminRoute(getWorkbotSettingsRoute(), access), role.read)
    assert.equal(canOpenAdminRoute(`${getWorkbotSettingsRoute()}/details`, access), role.read)
    assert.equal(access.canManageModelsSettings, role.manage)
    assert.equal(access.isAdmin, false)
    if (role.label === "manage-only") {
      assert.equal(access.canViewModelsSettings, false)
      assert.equal(canOpenAdminRoute("/dashboard/inference", access), false, "this compatibility rule does not grant unrelated settings pages")
    }
  })
}

test("the blocked Workbot settings page names either accepted permission", () => {
  const reason = adminRouteLockedMessage(getWorkbotSettingsRoute())
  assert.match(reason, /View OpenWork Models settings/)
  assert.match(reason, /Manage OpenWork Models/)
})
