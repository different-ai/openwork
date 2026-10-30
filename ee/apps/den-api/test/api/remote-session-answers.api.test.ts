import assert from "node:assert/strict"
import { after, test } from "node:test"
import { RemoteSessionCommandTable, RemoteSessionRequestTable } from "@openwork-ee/den-db/schema/remote-session-commands"
import { eq } from "@openwork-ee/den-db/drizzle"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { db } = await import("../../src/db.js")

const workspace = await den.createOrg(await den.signUp("Answer Owner"), "Remote answers workspace")
const teammate = await den.newMember(workspace.owner, workspace.orgId, "Answer Teammate")
const owner = den.as(workspace.owner, workspace.orgId)
const runnerId = "answers-runner"
const sessionId = "ses_answersfixture"
const answerBody = { sessionId, workspaceId: "answers-workspace", kind: "permission", requestId: "per_seen", decision: "once" }

// The owner's computer registers as a runner that takes answers, and has delivered one task.
const minted = await owner("POST", "/v1/session-runners/token", {
  runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: "0.0.0-test", platform: "darwin", concurrency: 1,
  capabilities: ["remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_answer_v1"],
})
assert.equal(minted.status, 200, summary(minted))
const runnerToken = text(field(minted.body, "token"), "runner token")
const commandId = createDenTypeId("remoteSessionCommand")
await db.insert(RemoteSessionCommandTable).values({
  id: commandId, org_id: workspace.orgId, owner_member_id: workspace.owner.memberId, created_by_user_id: workspace.owner.userId,
  status: "delivered", title: "Answer fixture", expires_at: new Date(Date.now() + 60_000), claimed_by_runner_id: runnerId,
  claimed_at: new Date(), session_id: sessionId, workspace_id: "answers-workspace", session_status: "waiting",
  session_waiting_for: "permission", session_engine: "v2", session_observed_at: new Date(),
  session_pending: { kind: "permission", requestId: "per_live", title: "Run a command", detail: "", command: "pnpm test" },
})

async function requestsFor() {
  return db.select().from(RemoteSessionRequestTable).where(eq(RemoteSessionRequestTable.command_id, commandId))
}

test("answering from the app is off until remoteSessionAnswers is on, even with tasks on other computers on", async () => {
  const off = await owner("POST", "/v1/remote-sessions/answer", answerBody)
  assert.equal(off.status, 404, summary(off))
  assert.equal(field(off.body, "error"), "feature_disabled")
  assert.equal((await den.setFeature(workspace.orgId, "remoteSessionSubagents", true)).status, 200)
  const stillOff = await owner("POST", "/v1/remote-sessions/answer", answerBody)
  assert.equal(stillOff.status, 404, summary(stillOff))
  assert.equal(field(stillOff.body, "error"), "feature_disabled")
  assert.equal((await requestsFor()).length, 0)
})

test("the owner's status shows what the task waits on, and a stale answer is refused by their computer", async () => {
  assert.equal((await den.setFeature(workspace.orgId, "remoteSessionSubagents", true)).status, 200)
  assert.equal((await den.setFeature(workspace.orgId, "remoteSessionAnswers", true)).status, 200)
  const status = await owner("POST", "/v1/remote-sessions/status", { threads: [{ commandId }] })
  assert.equal(status.status, 200, summary(status))
  assert.deepEqual(field(list(field(status.body, "threads"))[0], "pending"), { kind: "permission", requestId: "per_live", title: "Run a command" })

  // The computer claims the answer request and refuses it: per_seen is no longer what the session waits on.
  const computer = (async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const pending = await den.request(runnerToken, "GET", "/v1/remote-session-requests/pending")
      const item = list(field(pending.body, "items"))[0]
      if (item) {
        const requestId = text(field(item, "requestId"), "request id")
        const claimed = await den.request(runnerToken, "POST", `/v1/remote-session-requests/${requestId}/claim`, { body: {} })
        assert.equal(claimed.status, 200, summary(claimed))
        assert.equal(field(claimed.body, "assignment", "action"), "answer")
        assert.deepEqual(field(claimed.body, "assignment", "input"), { kind: "permission", requestId: "per_seen", decision: "once" })
        const done = await den.request(runnerToken, "POST", `/v1/remote-session-requests/${requestId}/complete`, {
          body: { status: "failed", error: { code: "stale_request", message: "That permission is no longer pending. Read the task again." } },
        })
        assert.equal(done.status, 200, summary(done))
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.fail("the answer request never reached the owner's computer")
  })()
  const answered = await owner("POST", "/v1/remote-sessions/answer", answerBody)
  await computer
  assert.equal(answered.status, 409, summary(answered))
  assert.equal(field(answered.body, "error"), "stale_request")
  assert.equal(field(answered.body, "retryable"), false)
})

test("a teammate cannot answer the owner's task, and always is never accepted", async () => {
  const before = (await requestsFor()).length
  const theirs = await den.as(teammate, workspace.orgId)("POST", "/v1/remote-sessions/answer", answerBody)
  assert.notEqual(theirs.status, 200, summary(theirs))
  assert.notEqual(field(theirs.body, "error"), "stale_request")
  const always = await owner("POST", "/v1/remote-sessions/answer", { ...answerBody, decision: "always" })
  assert.equal(always.status, 400, summary(always))
  assert.equal((await requestsFor()).length, before, "neither call reached the owner's computer")
})
