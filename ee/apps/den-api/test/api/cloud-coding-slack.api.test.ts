import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { after, test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { AuditEventTable, AuditEventResourceTable, CloudCodingPullRequestTable as PR, CloudCodingPushApprovalTable as Approval, CloudCodingSlackNoticeTable as Notice, CloudCodingTaskTable as Task, SlackAssistantEventTable as Event, SlackAssistantInstallationTable as Installation, SlackAssistantThreadTable as Thread } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { fakeRunner, fakeLive, fakeSlack } from "../slack-fakes.js"
import { startFakeGithubGit } from "./cloud-coding-fake-github-git.js"
import { bootDen, field, summary } from "./harness.js"

const github = await startFakeGithubGit()
after(() => github.close())
const den = await bootDen({ env: { ...github.env, DEN_DEPLOYMENT: "cloud", DEN_AUDIT_CAPTURE_ENABLED: "true", DEN_AUDIT_SELF_HOSTED_ENABLED: "true", DEN_HEADLESS_RUNNER_URL: "http://127.0.0.1:1", DEN_HEADLESS_RUNNER_TOKEN: "acme-runner-fixture-token-for-tests" } })
after(() => den.close())
const { db } = await import("../../src/db.js")
const { queueCloudCodingSlackNotice, sweepCloudCodingSlackNotices } = await import("../../src/cloud-coding/slack/notices.js")
const { cloudCodingSlackOrigin } = await import("../../src/cloud-coding/slack/origin.js")
const { findCloudCodingRepository } = await import("../../src/cloud-coding/installation.js")
const { createExternalMcpConnection } = await import("../../src/capability-sources/external-mcp-connections.js")
const { upsertConnectedAccount } = await import("../../src/capability-sources/oauth-credentials.js")
const { recordSlackRunToken } = await import("../../src/slack-assistant/desktop-handoff.js")
const { mintHeadlessRunMcpToken } = await import("../../src/mcp/headless-run-token-mint.js")
const { bindSlackOAuthMember, claimSlackEvent } = await import("../../src/slack-assistant/repository.js")
const { scopeKey, slackClient } = await import("../../src/slack-assistant/protocol.js")
const { processSlackEvent } = await import("../../src/slack-assistant/worker.js")
const { checkpointSchema } = await import("../../src/slack-assistant/run.js")

const maya = await den.signUp("Maya Chen", "maya@acme.dev")
const org = await den.createOrg(maya, "Acme Corp")
const sam = await den.newMember(org.owner, org.orgId, "Sam Rivera")
const organizationId = normalizeDenTypeId("organization", org.orgId)
const memberId = normalizeDenTypeId("member", org.owner.memberId)
const own = den.as(org.owner, org.orgId)
assert.equal((await den.setFeature(org.orgId, "cloudCoding", true)).status, 200)
const fullName = "acme/storefront"
const sha = await github.seedRepository(fullName, { "README.md": "Original\n" })
github.addRepository({ id: 11, full_name: fullName, default_branch: "main", private: true, archived: false })
github.addInstallation({ id: 51, account: { id: 71, login: "acme", type: "Organization" }, repository_selection: "selected", suspended_at: null, html_url: `${github.url}/settings/installations/51`, repositoryIds: [11] })
github.addUser({ id: 1, login: "maya-chen", name: "Maya Chen", installationIds: [51], writableRepositoryIds: [11] })
github.addUser({ id: 2, login: "sam-rivera", name: "Sam Rivera", installationIds: [51], writableRepositoryIds: [11] })
const cloudRoot = "/v1/cloud-coding"
async function connect(call: typeof own, githubId: number, installationId?: number) {
  const start = installationId ? await call("POST", `${cloudRoot}/github/install/start`, {}) : await call("POST", `${cloudRoot}/github/link/start`)
  assert.equal(start.status, 200, summary(start))
  const state = new URL(z.string().parse(field(start.body, "redirectUrl"))).searchParams.get("state")
  const done = await call("POST", `${cloudRoot}/github/callback`, { state, code: github.issueCode(githubId), installationId })
  assert.equal(done.status, 200, summary(done))
}
await connect(own, 1, 51)
await connect(den.as(sam, org.orgId), 2)
const repo = await findCloudCodingRepository({ organizationId, fullName })
assert.ok(repo)
const repositoryId = repo.id
const signingSecret = "slack-signing-fixture"
const teamId = "TACME"
const appId = "AACME"
const mayaSlack = "UMAYA"
const samSlack = "USAM"
const channelId = "CACME"
const slack = fakeSlack()
const originalFetch = globalThis.fetch
const slackFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.host !== "slack.com") return originalFetch(input, init)
  const method = url.pathname.split("/").at(-1) ?? ""
  const body = z.record(z.string(), z.unknown()).parse(JSON.parse(String(init?.body)))
  return Response.json(await slack.slack(method, body))
}
globalThis.fetch = slackFetch
after(() => { globalThis.fetch = originalFetch })

async function install(team: string) {
  const connection = await createExternalMcpConnection({ organizationId, name: "Acme Corp", url: "https://mcp.slack.com/mcp", authType: "oauth", credentialMode: "per_member", createdByOrgMembershipId: memberId, access: { orgWide: true, memberIds: [], teamIds: [] } })
  await db.insert(Installation).values({ connectionId: connection.id, organizationId, enabled: true, signingSecret, teamId: team, appId, botToken: "slack-bot-fixture" })
  return connection
}
const connection = await install(teamId)
const otherConnection = await install("TOTHER")
for (const [id, user] of [[memberId, mayaSlack], [normalizeDenTypeId("member", sam.memberId), samSlack]] as const) {
  await upsertConnectedAccount({ organizationId, orgMembershipId: id, providerId: connection.id, accessToken: user })
  await bindSlackOAuthMember(connection, id, () => async () => ({ ok: true, user_id: user, team_id: teamId }))
}
let time = Date.now() + 2_000
const sweep = () => sweepCloudCodingSlackNotices({ slack: (token) => slackClient(token, slackFetch), now: () => time })
const next = (ms = 2_500) => { time += ms }
const notices = (id: typeof Notice.$inferSelect.approvalId) => db.select().from(Notice).where(eq(Notice.approvalId, id)).then(([row]) => row)
const calls = (method: string) => slack.calls.filter((call) => call.method === method)
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return
    await sleep(20)
  }
  assert.fail("Slack work did not finish")
}

let sequence = 0
async function seed(options: { private?: boolean; status?: typeof Approval.$inferSelect.status } = {}) {
  const threadTs = `1900000000.${++sequence}`
  const eventId = scopeKey(connection.id, threadTs)
  const sessionId = `hs_acme${sequence}`
  const reply = options.private ? { channel: "DACME", threadTs: `1900000001.${sequence}` } : { channel: channelId, threadTs }
  const cp = checkpointSchema.parse({ ...reply, phase: "finish", sessionId, workbot: true, live: false, answerReply: true, privateReply: options.private })
  await db.insert(Event).values({ id: eventId, connectionId: connection.id, teamId, channelId, threadTs, slackUserId: mayaSlack, payload: JSON.stringify({ type: "app_mention" }), checkpoint: JSON.stringify(cp), status: "done" })
  await db.insert(Thread).values({ id: scopeKey(connection.id, teamId, channelId, threadTs, memberId), connectionId: connection.id, memberId, channelId, threadTs, sessionId })
  const token = await mintHeadlessRunMcpToken({ organizationId, userId: maya.userId })
  await recordSlackRunToken({ ...token, userId: maya.userId, messageId: `msg_${eventId}.t1.r` })
  const taskId = createDenTypeId("cloudCodingTask")
  const id = createDenTypeId("cloudCodingPushApproval")
  const branch = `openwork/acme-${sequence}`
  await db.transaction(async (tx) => {
    await tx.insert(Task).values({ id: taskId, organizationId, orgMembershipId: memberId, repositoryId, githubRepositoryId: 11, repositoryFullName: fullName, baseBranch: "main", title: "Update storefront", status: "awaiting_approval", surface: "slack", runTokenId: token.tokenId })
    await tx.insert(Approval).values({ id, taskId, organizationId, orgMembershipId: memberId, githubRepositoryId: 11, repositoryFullName: fullName, branch, baseBranch: "main", baseSha: sha, treeSha: sha, headSha: sha, commitTime: 1900000000, authorName: "Maya Chen", authorEmail: "maya@acme.dev", commitMessage: "Update storefront", title: "Update storefront", expiresAt: new Date(Date.now() + 3_600_000), status: options.status ?? "pending", summary: { files: Array.from({ length: 6 }, (_, i) => ({ path: `src/file${i}.ts`, change: "modified" })), fileCount: 6, tests: { status: "passed", command: null, summary: null } } })
    const [task] = await tx.select().from(Task).where(eq(Task.id, taskId))
    const [approval] = await tx.select().from(Approval).where(eq(Approval.id, id))
    assert.ok(task && approval)
    await queueCloudCodingSlackNotice(tx, { approval, task })
    await queueCloudCodingSlackNotice(tx, { approval, task })
  })
  const row = await notices(id)
  assert.ok(row)
  return { id, taskId, branch, token, sessionId, eventId, threadTs, reply }
}

type Fixture = Awaited<ReturnType<typeof seed>>
const current = (f: Fixture) => db.select().from(Approval).where(eq(Approval.id, f.id)).then(([row]) => row)
const web = (f: Fixture, decision = "allow_once") => own("POST", `${cloudRoot}/approvals/${f.id}/decision`, { decision })
async function click(f: Fixture, options: { user?: string; decision?: "allow_once" | "deny"; channel?: string; ts?: string; signature?: string; other?: boolean } = {}) {
  const row = await notices(f.id)
  assert.ok(row?.messageTs)
  const decision = options.decision ?? "allow_once"
  const rawBody = new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", team: { id: options.other ? "TOTHER" : teamId }, api_app_id: appId, user: { id: options.user ?? mayaSlack }, channel: { id: options.channel ?? row.channelId }, message: { ts: options.ts ?? row.messageTs }, actions: [{ action_id: `cloud_coding_approval:${f.id}:${decision}`, value: decision }] }) }).toString()
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`
  return den.request(null, "POST", `/v1/integrations/slack/${options.other ? otherConnection.id : connection.id}/interactions`, { rawBody, headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": timestamp, "x-slack-signature": options.signature ?? signature } })
}
async function audit(f: Fixture) {
  return db.select({ action: AuditEventTable.action, envelope: AuditEventTable.envelope }).from(AuditEventTable)
    .innerJoin(AuditEventResourceTable, eq(AuditEventTable.id, AuditEventResourceTable.event_id))
    .where(and(eq(AuditEventResourceTable.resource_id, f.id), eq(AuditEventResourceTable.resource_type, "cloud_coding_approval")))
}

const visible = (body: unknown) => JSON.stringify(body)
async function post(options?: Parameters<typeof seed>[0]) {
  const f = await seed(options)
  next()
  await Promise.all([sweep(), sweep()])
  return f
}

test("posts one private-thread request with the exact decision and summary blocks", async () => {
  const start = calls("chat.postMessage").length
  const f = await post({ private: true })
  next()
  await sweep()
  const [msg] = calls("chat.postMessage").slice(start)
  assert.ok(msg)
  assert.equal(calls("chat.postMessage").length, start + 1)
  assert.equal(msg.body.channel, f.reply.channel)
  assert.equal(msg.body.thread_ts, f.reply.threadTs)
  const body = visible(msg.body)
  for (const text of [f.branch, "6 files changed", "src/file4.ts", "and 1 more", sha.slice(0, 7), "Tests passed", "Nothing has been sent to GitHub yet. Only <@UMAYA> can approve.", `/dashboard/cloud-coding/approvals/${f.id}|Open in OpenWork`, `cloud_coding_approval:${f.id}:allow_once`, `cloud_coding_approval:${f.id}:deny`]) assert.ok(body.includes(text), body)
  assert.doesNotMatch(body, /src\/file5.ts/)
  assert.equal((await click(f, { decision: "deny" })).status, 200)
  await until(async () => (await notices(f.id))?.shownStatus === "denied")
})

test("only the requester can decide, copied coordinates and invalid signatures are refused", async () => {
  const f = await post()
  const start = calls("chat.postEphemeral").length
  for (const user of [samSlack, "ULEO"]) assert.equal((await click(f, { user })).status, 200)
  await until(() => calls("chat.postEphemeral").length === start + 2)
  for (const [index, user] of [samSlack, "ULEO"].entries()) assert.equal(calls("chat.postEphemeral")[start + index]?.body.user, user)
  for (const call of calls("chat.postEphemeral").slice(start)) assert.equal(call.body.text, "Only <@UMAYA> can approve or deny this push.")
  for (const options of [{ channel: "COTHER" }, { ts: "42.42" }, { other: true }]) assert.equal((await click(f, options)).status, 200)
  assert.equal((await click(f, { signature: "v0=invalid" })).status, 401)
  assert.equal((await current(f))?.status, "pending")
  assert.equal((await audit(f)).length, 0)
})

test("Slack approves once, records the member audit, removes buttons and rejects the web replay", async () => {
  const f = await post()
  const updates = calls("chat.update").length
  const ephemeral = calls("chat.postEphemeral").length
  const [first, second] = await Promise.all([click(f), click(f)])
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  await until(async () => (await notices(f.id))?.shownStatus === "approved" && calls("chat.postEphemeral").length > ephemeral)
  assert.equal((await current(f))?.status, "approved")
  const change = (await audit(f)).filter((row) => row.action === "cloud_coding.push.approved")
  assert.equal(change.length, 1)
  assert.equal(change[0]?.envelope?.actor.memberId, memberId)
  const update = calls("chat.update")[updates]
  assert.equal(update?.body.text, "Approved by <@UMAYA>. Pushing the branch…")
  assert.doesNotMatch(visible(update?.body.blocks), /action_id/)
  assert.equal(calls("chat.postEphemeral")[ephemeral]?.body.text, "This push was already approved.")
  assert.equal((await click(f)).status, 200)
  await until(() => calls("chat.postEphemeral").length === ephemeral + 2)
  assert.equal(calls("chat.postEphemeral")[ephemeral + 1]?.body.text, "This push was already approved.")
  const result = await web(f, "deny")
  assert.equal(result.status, 409)
  assert.equal(field(result.body, "error"), "approval_not_pending")
  await db.update(Approval).set({ status: "expired" }).where(eq(Approval.id, f.id))
})

test("web denial settles Slack; Slack denial cancels the task", async () => {
  const f = await post()
  assert.equal((await web(f, "deny")).status, 200)
  next()
  await sweep()
  assert.equal((await notices(f.id))?.shownStatus, "denied")
  const ephemeral = calls("chat.postEphemeral").length
  assert.equal((await click(f)).status, 200)
  await until(() => calls("chat.postEphemeral").length > ephemeral)
  assert.equal(calls("chat.postEphemeral")[ephemeral]?.body.text, "This push was already denied.")
  const g = await post()
  assert.equal((await click(g, { decision: "deny" })).status, 200)
  await until(async () => (await notices(g.id))?.shownStatus === "denied")
  const [task] = await db.select().from(Task).where(eq(Task.id, g.taskId))
  assert.equal(task?.status, "cancelled")
  assert.equal(calls("chat.update").at(-1)?.body.text, "Denied by <@UMAYA>. Nothing was pushed.")
})

async function pullRequest(f: Fixture) {
  await db.insert(PR).values({ id: createDenTypeId("cloudCodingPullRequest"), organizationId, openedByOrgMembershipId: memberId, openedByName: "Maya Chen", approvalId: f.id, taskId: f.taskId, githubRepositoryId: 11, repositoryFullName: fullName, number: sequence, title: "Update storefront", url: `https://github.com/${fullName}/pull/${sequence}`, branch: f.branch, headSha: sha })
}

test("refreshes expired, superseded, pushed; skips approvals settled before a post", async () => {
  const start = calls("chat.postMessage").length
  await post({ status: "denied" })
  assert.equal(calls("chat.postMessage").length, start)
  for (const [status, line] of [["expired", "This request expired."], ["superseded", "Replaced by a newer request."]] as const) {
    const f = await post()
    await db.update(Approval).set(status === "expired" ? { expiresAt: new Date(Date.now() - 60_000) } : { status }).where(eq(Approval.id, f.id))
    next()
    await sweep()
    assert.equal((await notices(f.id))?.shownStatus, status)
    assert.equal(calls("chat.update").at(-1)?.body.text, line)
  }
  const f = await post()
  await db.update(Approval).set({ status: "pushed" }).where(eq(Approval.id, f.id))
  next()
  await sweep()
  assert.notEqual((await notices(f.id))?.shownStatus, "pushed")
  await pullRequest(f)
  next()
  await sweep()
  assert.equal((await notices(f.id))?.shownStatus, "pushed")
  assert.match(String(calls("chat.update").at(-1)?.body.text), /Pull request: <https:\/\/github.com\/acme\/storefront\/pull\/\d+\|acme\/storefront #\d+>/)
})

test("continues once through the Slack runner, and does not continue when the PR arrives first", async () => {
  const f = await post({ private: true })
  const quick = await post()
  for (const entry of [f, quick]) {
    await db.update(Approval).set({ status: "approved", decidedAt: new Date(time) }).where(eq(Approval.id, entry.id))
  }
  next()
  await sweep()
  assert.equal((await notices(f.id))?.continuedAt, null)
  await pullRequest(quick)
  await db.update(Approval).set({ status: "pushed" }).where(eq(Approval.id, quick.id))
  next(21_000)
  await sweep()
  next()
  await sweep()
  assert.equal((await notices(quick.id))?.continuedAt, null)
  assert.ok((await notices(f.id))?.continuedAt)
  const continuationId = scopeKey("cloud-coding-slack-continuation", f.id)
  const [queued] = await db.select().from(Event).where(eq(Event.id, continuationId))
  assert.ok(queued)
  await db.update(Event).set({ availableAt: new Date(Date.now() - 60_000) }).where(eq(Event.id, continuationId))
  const event = await claimSlackEvent()
  assert.equal(event?.id, continuationId)
  assert.ok(event)
  const runner = fakeRunner()
  await processSlackEvent(event, { model: async () => "test-model", slack: () => slack.slack, runner: (actor) => { assert.equal(actor.memberId, memberId); return runner.runner }, live: fakeLive().source })
  assert.equal(runner.sent.length, 1)
  assert.equal(runner.sent[0]?.sessionId, f.sessionId)
  assert.equal(runner.sent[0]?.messageId, `msg_${continuationId}`)
  assert.match(runner.sent[0]?.prompt ?? "", new RegExp(`taskId ${f.taskId}`))
  assert.equal(runner.sent[0]?.settings?.computer, true)
  const [result] = await db.select().from(Event).where(eq(Event.id, continuationId))
  const cp = checkpointSchema.parse(JSON.parse(result?.checkpoint ?? "{}"))
  assert.equal(cp.channel, f.reply.channel)
  assert.equal(cp.threadTs, f.reply.threadTs)
  assert.equal((await db.select().from(Event).where(eq(Event.id, continuationId))).length, 1)
  await db.update(Event).set({ status: "done" }).where(eq(Event.id, continuationId))
})

test("Slack origin resolves live owned turns; the computer stays off for an ineligible member", async () => {
  const f = await seed({ private: true })
  const origin = (runTokenId: string, userId = maya.userId) => cloudCodingSlackOrigin({ runTokenId, organizationId, userId })
  assert.deepEqual(await origin(f.token.tokenId), { connectionId: connection.id, eventId: f.eventId, sessionId: f.sessionId, runnerMessageId: `msg_${f.eventId}`, teamId, channelId: f.reply.channel, threadTs: f.reply.threadTs, requesterSlackUserId: mayaSlack })
  assert.equal(await origin(f.token.tokenId, sam.userId), null)
  const workbot = await mintHeadlessRunMcpToken({ organizationId, userId: maya.userId })
  assert.equal(await origin(workbot.tokenId), null)
  const expired = await mintHeadlessRunMcpToken({ organizationId, userId: maya.userId, ttlMs: -1 })
  await recordSlackRunToken({ ...expired, userId: maya.userId, messageId: `msg_${f.eventId}` })
  assert.equal(await origin(expired.tokenId), null)
  assert.equal((await den.setFeature(org.orgId, "cloudCoding", false)).status, 200)
  const id = scopeKey(connection.id, "computer-off")
  const cp = checkpointSchema.parse({ phase: "send", channel: channelId, threadTs: "2.2", sessionId: "hs_off", workbot: true, live: false, prompt: "Check this thread" })
  await db.insert(Event).values({ id, connectionId: connection.id, teamId, channelId, threadTs: "2.2", slackUserId: samSlack, status: "running", payload: JSON.stringify({ type: "app_mention" }), checkpoint: JSON.stringify(cp) })
  const otherEvent = await claimSlackEvent()
  assert.equal(otherEvent?.id, id)
  assert.ok(otherEvent)
  const runner = fakeRunner()
  await processSlackEvent(otherEvent, { model: async () => "test-model", slack: () => slack.slack, runner: () => runner.runner, live: fakeLive().source })
  assert.equal(runner.sent[0]?.settings?.computer, false)
})
