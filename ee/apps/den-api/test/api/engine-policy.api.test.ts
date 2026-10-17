import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, summary, text } from "./harness.js"

const den = await bootDen()
after(() => den.close())

const inventory = { computer: { label: "Test desktop", platform: "darwin", appVersion: "0.0.0-test" }, workspaces: [] }

async function runnerToken(owner: Parameters<typeof den.as>[0], orgId: string) {
  const minted = await den.as(owner, orgId)("POST", "/v1/session-runners/token", {
    runnerId: "test-install", protocolVersion: 1, supportedExecutionTargets: ["desktop"], capabilities: [],
    appVersion: "0.0.0-test", platform: "darwin", concurrency: 1,
  })
  assert.equal(minted.status, 200, summary(minted))
  return text(field(minted.body, "token"), "runner token")
}

test("existing desktop inventory returns only the live upgrade policy for the runner's organization", async () => {
  const { owner, orgId } = await den.createOrg(await den.signUp("Policy Owner"), "Policy test organization")
  const other = await den.createOrg(await den.signUp("Isolated Owner"), "Isolated test organization")
  const token = await runnerToken(owner, orgId)
  const isolatedToken = await runnerToken(other.owner, other.orgId)
  for (const enabled of [false, true, false]) {
    assert.equal((await den.setFeature(orgId, "engineV2ForceUpgrade", enabled)).status, 200)
    for (const path of ["/v1/session-runners/inventory", "/v1/automation-runner/inventory"]) {
      const stored = await den.request(token, "PUT", path, { body: inventory })
      assert.equal(stored.status, 200, summary(stored))
      assert.deepEqual(field(stored.body, "enginePolicy"), { upgrade: enabled })
      assert.equal(stored.headers.get("cache-control"), "no-store")
    }
    const isolated = await den.request(isolatedToken, "PUT", "/v1/session-runners/inventory", { body: inventory })
    assert.equal(isolated.status, 200, summary(isolated))
    assert.deepEqual(field(isolated.body, "enginePolicy"), { upgrade: false })
  }
})

test("runner work polling observes policy off/on/off without any inventory upload", async () => {
  const { owner, orgId } = await den.createOrg(await den.signUp("Polling Owner"), "Polling test organization")
  const token = await runnerToken(owner, orgId)
  for (const enabled of [false, true, false]) {
    assert.equal((await den.setFeature(orgId, "engineV2ForceUpgrade", enabled)).status, 200)
    for (const path of ["/v1/session-runners/work", "/v1/automation-runner/work"]) {
      const work = await den.request(token, "GET", path)
      assert.equal(work.status, 200, summary(work))
      assert.deepEqual(field(work.body, "enginePolicy"), { upgrade: enabled })
      assert.deepEqual(field(work.body, "items"), [])
      assert.equal(work.headers.get("cache-control"), "no-store")
    }
  }
})

test("existing worker heartbeat returns the org's live upgrade policy without changing its activity payload", async () => {
  const { owner, orgId } = await den.createOrg(await den.signUp("Web Policy Owner"), "Web policy test organization")
  const workerId = createDenTypeId("worker")
  const otherWorkerId = createDenTypeId("worker")
  // Arrange only: provisioned workers receive these credentials outside the heartbeat API.
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("API test requires MySQL")
  for (const id of [workerId, otherWorkerId]) {
    await client.execute("INSERT INTO worker (id, org_id, created_by_user_id, name, destination, status) VALUES (?, ?, ?, ?, 'cloud', 'healthy')", [id, orgId, owner.userId, "Test web instance"])
  }
  await client.execute("INSERT INTO worker_token (id, worker_id, scope, token) VALUES (?, ?, 'activity', ?), (?, ?, 'client', ?)", [createDenTypeId("workerToken"), workerId, "synthetic-activity-token", createDenTypeId("workerToken"), workerId, "synthetic-client-token"])
  const path = `/v1/workers/${workerId}/activity-heartbeat`
  const body = { sentAt: new Date().toISOString(), isActiveRecently: true, openSessionCount: 1, lastActivityAt: new Date().toISOString() }
  const wrongScope = await den.request("synthetic-client-token", "POST", path, { body })
  assert.equal(wrongScope.status, 401, summary(wrongScope))
  assert.equal((await den.request("synthetic-activity-token", "POST", `/v1/workers/${otherWorkerId}/activity-heartbeat`, { body })).status, 401)
  for (const enabled of [false, true, false]) {
    assert.equal((await den.setFeature(orgId, "engineV2ForceUpgrade", enabled)).status, 200)
    const accepted = await den.request("synthetic-activity-token", "POST", path, { body })
    assert.equal(accepted.status, 200, summary(accepted))
    assert.deepEqual(field(accepted.body, "enginePolicy"), { upgrade: enabled })
    assert.equal(field(accepted.body, "isActiveRecently"), true)
    assert.equal(field(accepted.body, "openSessionCount"), 1)
    assert.equal(field(accepted.body, "lastActiveAt"), body.lastActivityAt)
    assert.equal(accepted.headers.get("cache-control"), "no-store")
  }
})
