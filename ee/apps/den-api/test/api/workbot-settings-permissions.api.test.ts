import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable } from "@openwork-ee/den-db/schema"
import type { PermissionKey } from "@openwork/types/den/permissions"
import { modelProbeFixture } from "../../../headless-runner/scripts/model-probe-fixture.js"
import { bootDen, field, strings, summary, type Member } from "./harness.js"
import { grantGatewayModels, memberGatewayKey, stubPublicModelCatalog } from "./gateway-fixture.js"

// Workbot models come from each caller's own AI Gateway access; the synthetic provider stands in for the Gateway.
const runner = await modelProbeFixture({ protocol: "openai-responses" })
const restoreFetch = stubPublicModelCatalog()
const den = await bootDen({ env: {
  DEN_HEADLESS_RUNNER_URL: runner.url, DEN_HEADLESS_RUNNER_TOKEN: "r".repeat(32),
  GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: runner.providerUrl, GATEWAY_PUBLIC_BASE_URL: runner.providerUrl,
} })
after(async () => { restoreFetch(); await den.close(); await runner.close() })
const path = "/v1/org/workbot-settings"
const probe = `${path}/test-default-model`

test("view-only and manage-only members can always read; writes/probes remain manage-only and fresh", async () => {
  const workspace = await den.createOrg(await den.signUp("Permission Owner"), "Permission workspace")
  const owner = den.as(workspace.owner, workspace.orgId)
  const roles: { label: string; keys: PermissionKey[]; read: boolean; manage: boolean }[] = [
    { label: "View Only", keys: ["inference.view"], read: true, manage: false },
    { label: "Manage Only", keys: ["inference.manage"], read: true, manage: true },
    { label: "Neither", keys: [], read: false, manage: false },
  ]
  const people: { member: Member; read: boolean; manage: boolean }[] = []
  for (const role of roles) {
    const member = await den.newMember(workspace.owner, workspace.orgId, role.label)
    if (role.keys.length > 0) {
      const teamId = await den.createTeam(workspace.owner, workspace.orgId, role.label, [member.memberId])
      const grant = await owner("POST", "/v1/permissions/sets", { teamId, permissions: role.keys.map(key => ({ key, status: "allow" })) })
      assert.equal(grant.status, 201, summary(grant))
    }
    const context = await den.as(member, workspace.orgId)("GET", "/v1/org")
    assert.deepEqual(strings(field(context.body, "currentMember", "permissions")), role.keys, `the ${role.label} member holds exactly the tested keys`)
    assert.equal(field(context.body, "currentMember", "isOwner"), false)
    people.push({ member, read: role.read, manage: role.manage })
  }
  // Every person, including the one without permissions, holds a Luna Gateway grant: model access never confers
  // permission to read or change the organization's Workbot settings.
  const { "gpt-6-luna": luna } = await grantGatewayModels(den, workspace.owner, workspace.orgId, people.map(person => person.member))
  for (const person of people) runner.acceptModelKey(await memberGatewayKey(workspace.orgId, person.member))

  for (const person of people) {
    const call = den.as(person.member, workspace.orgId)
    const read = await call("GET", path)
    assert.equal(read.status, person.read ? 200 : 403, summary(read))
    if (person.read) {
      assert.equal(field(read.body, "defaultReadiness"), "available")
    } else {
      assert.equal(field(read.body, "models"), undefined)
      assert.equal(read.text.includes(String(luna)), false)
    }
    const saved = await call("PUT", path, { model: null })
    assert.equal(saved.status, person.manage ? 200 : 403, summary(saved))
    const checked = await call("POST", probe, {})
    assert.equal(checked.status, person.manage ? 200 : 403, summary(checked))
    if (person.manage) assert.equal(field(checked.body, "status"), "answered")
  }
  assert.equal(runner.calls().length, 1, "only the fresh manage-only member can trigger inference")

  const manager = people.find(person => person.manage)?.member
  assert.ok(manager)
  const { db } = await import("../../src/db.js")
  await db.update(AuthSessionTable).set({ createdAt: new Date(Date.now() - 3 * 60 * 60_000) }).where(eq(AuthSessionTable.userId, manager.userId))
  const stale = den.as(manager, workspace.orgId)
  assert.equal((await stale("GET", path)).status, 200, "safe manager reads do not inherit sensitive-write freshness requirements")
  for (const result of [await stale("PUT", path, { model: null }), await stale("POST", probe, {})]) {
    assert.equal(result.status, 403, summary(result))
    assert.equal(field(result.body, "reason"), "fresh_auth_required")
  }
  assert.equal(runner.calls().length, 1)
})

test("the step limit is read and saved only while workbotStepLimit is on, by people who manage models, and reaches Workbot's session", async () => {
  const workspace = await den.createOrg(await den.signUp("Step Limit Owner"), "Step limit workspace")
  const owner = den.as(workspace.owner, workspace.orgId)
  const member = den.as(await den.newMember(workspace.owner, workspace.orgId, "Step Limit Member"), workspace.orgId)
  const token = await den.mintMcpToken(workspace.owner, workspace.orgId)
  const session = async () => {
    const read = await den.request(token, "GET", "/v1/workbot/session")
    assert.equal(read.status, 200, summary(read))
    return read.body
  }
  const settings = async () => {
    const read = await owner("GET", path)
    assert.equal(read.status, 200, summary(read))
    return read.body
  }
  const feature = async (enabled: boolean) => {
    const set = await den.setFeature(workspace.orgId, "workbotStepLimit", enabled)
    assert.equal(set.status, 200, summary(set))
  }

  // Off: neither response mentions it, saving it is refused, and the model alone saves as it always has.
  assert.equal(field(await settings(), "maxSteps"), undefined)
  assert.equal(field(await session(), "maxSteps"), undefined)
  const refused = await owner("PUT", path, { maxSteps: 250 })
  assert.equal(refused.status, 400, summary(refused))
  assert.equal(field(refused.body, "error"), "invalid_request")
  const refusedWithModel = await owner("PUT", path, { model: null, maxSteps: 250 })
  assert.equal(refusedWithModel.status, 400, summary(refusedWithModel))
  const modelOnly = await owner("PUT", path, { model: null })
  assert.equal(modelOnly.status, 200, summary(modelOnly))
  assert.equal(field(modelOnly.body, "maxSteps"), undefined)

  // On: null (the deployment's default) until an admin chooses.
  await feature(true)
  assert.equal(field(await settings(), "maxSteps"), null)
  assert.equal(field(await session(), "maxSteps"), null)
  const saved = await owner("PUT", path, { maxSteps: 250 })
  assert.equal(saved.status, 200, summary(saved))
  assert.equal(field(saved.body, "maxSteps"), 250)
  assert.equal(field(saved.body, "model"), null)
  assert.equal(field(await settings(), "maxSteps"), 250)
  assert.equal(field(await session(), "maxSteps"), 250)

  // The model and the limit save together; either one alone leaves the other as it was.
  const both = await owner("PUT", path, { model: null, maxSteps: 0 })
  assert.equal(both.status, 200, summary(both))
  assert.equal(field(both.body, "maxSteps"), 0)
  assert.equal(field(await session(), "maxSteps"), 0, "no limit is its own value")
  const modelAgain = await owner("PUT", path, { model: null })
  assert.equal(modelAgain.status, 200, summary(modelAgain))
  assert.equal(field(modelAgain.body, "maxSteps"), 0)

  for (const body of [{ maxSteps: 100_001 }, { maxSteps: -1 }, { maxSteps: 2.5 }, {}]) {
    const invalid = await owner("PUT", path, body)
    assert.equal(invalid.status, 400, summary(invalid))
  }
  const denied = await member("PUT", path, { maxSteps: 100 })
  assert.equal(denied.status, 403, summary(denied))
  assert.equal((await member("GET", path)).status, 403)
  assert.equal(field(await settings(), "maxSteps"), 0)

  const cleared = await owner("PUT", path, { maxSteps: null })
  assert.equal(cleared.status, 200, summary(cleared))
  assert.equal(field(cleared.body, "maxSteps"), null)
  assert.equal(field(await session(), "maxSteps"), null)

  // Off again with a limit saved: the value is kept but ignored, and Workbot is told to clear it from its chats.
  assert.equal((await owner("PUT", path, { maxSteps: 500 })).status, 200)
  await feature(false)
  assert.equal(field(await settings(), "maxSteps"), undefined)
  assert.equal(field(await session(), "maxSteps"), null)
  await feature(true)
  assert.equal(field(await settings(), "maxSteps"), 500)
  assert.equal(field(await session(), "maxSteps"), 500)
})
