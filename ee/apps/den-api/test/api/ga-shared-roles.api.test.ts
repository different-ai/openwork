import assert from "node:assert/strict"
import { after, test } from "node:test"
import { OrganizationFeatureTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, summary, text } from "./harness.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "self_hosted", DEN_FEATURE_PERMISSIONS: "false", DEN_FEATURE_SHARED_ROLES: "false" } })
after(() => den.close())

test("shared roles stay available on self-hosted with stale off overrides and outlive their last team", async () => {
  const workspace = await den.createOrg(await den.signUp("Role Owner"), "Role workspace")
  const call = den.as(workspace.owner, workspace.orgId)
  const { db } = await import("../../src/db.js")
  for (const feature_key of ["permissions", "sharedRoles"]) {
    await db.insert(OrganizationFeatureTable).values({ organization_id: normalizeDenTypeId("organization", workspace.orgId), feature_key, enabled: false, source: "platform" })
  }
  const teamId = await den.createTeam(workspace.owner, workspace.orgId, "Role team", [])
  const created = await call("POST", "/v1/permissions/sets", { name: "Shared inference reader", teamIds: [teamId], permissions: [{ key: "inference.view", status: "allow" }] })
  assert.equal(created.status, 201, summary(created))
  const setId = text(field(created.body, "set", "id"), "permission set ID")
  const renamed = await call("PATCH", `/v1/permissions/sets/${setId}`, { name: "Inference reader" })
  assert.equal(renamed.status, 200, summary(renamed))
  const removed = await call("DELETE", `/v1/teams/${teamId}`)
  assert.equal(removed.status, 204, summary(removed))
  const role = await call("GET", `/v1/permissions/sets/${setId}`)
  assert.equal(role.status, 200, summary(role))
  assert.equal(field(role.body, "set", "archivedAt"), null, "removing the last linked team must not archive a reusable role")
  const nextTeamId = await den.createTeam(workspace.owner, workspace.orgId, "Replacement team", [])
  const reassigned = await call("PUT", `/v1/teams/${nextTeamId}/permission-set`, { permissionSetId: setId })
  assert.equal(reassigned.status, 200, summary(reassigned))
})
