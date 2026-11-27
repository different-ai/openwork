import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { CloudCodingInstallationTable as Installations, CloudCodingPullRequestTable as PullRequests, CloudCodingPushApprovalTable as Approvals, CloudCodingTaskTable as Tasks } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { cloudCodingGithubCallbackResultSchema, cloudCodingRedirectSchema } from "@openwork/types/den/cloud-coding"
import { openworkCloudMcpConnectionActionSchema } from "@openwork/types/den/mcp-connection-action"
import { connectionActionPayloadSchema } from "@openwork/types/connection-action-app"
import { z } from "zod"
import { bootDen, field, summary, text, type McpToolResult } from "./harness.js"
import { startFakeGithub } from "./cloud-coding-fake-github.js"

const github = await startFakeGithub()
after(() => github.close())
const den = await bootDen({ env: { ...github.env, DEN_DEPLOYMENT: "cloud", DEN_AUDIT_CAPTURE_ENABLED: "true", DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(() => den.close())
const { env } = await import("../../src/env.js")
const { db } = await import("../../src/db.js")
const { setCloudCodingSessionStarterForTests } = await import("../../src/cloud-coding/mcp/capabilities.js")
const { redeemCloudCodingSetupCode } = await import("../../src/cloud-coding/tasks.js")
const maya = await den.createOrg(await den.signUp("Maya Chen"), "Acme Corp")
const sam = await den.newMember(maya.owner, maya.orgId, "Sam Rivera")
const leo = await den.createOrg(await den.signUp("Leo Martin"), "Acme Corp")
const organizationId = normalizeDenTypeId("organization", maya.orgId)
const mayaToken = await den.mintMcpToken(maya.owner, maya.orgId)
const samToken = await den.mintMcpToken(sam, maya.orgId)
const leoToken = await den.mintMcpToken(leo.owner, leo.orgId)
const manage = den.as(maya.owner, maya.orgId)
const cloudPath = "/v1/cloud-coding"
const settingsPath = `${cloudPath}/settings`
const webPath = `${env.webUrl}/dashboard/cloud-coding`
const task = "Fix the one-cent rounding bug in checkout."
const startArgs = { repository: "storefront", task }
const execute = (action: string, args: object = {}, token = mayaToken) => den.callMcpTool(token, "execute_capability", { name: `cloud-coding:${action}`, arguments: args })
const start = (args: object = startArgs, token = mayaToken) => execute("start", args, token)
const search = async (query: string) => {
  const result = await den.callMcpTool(mayaToken, "search_capabilities", { query })
  assert.equal(result.isError, false, result.raw)
  return z.object({ matches: z.array(z.object({ name: z.string(), readOnly: z.boolean().optional() })) }).parse(result.body).matches
}
const taskRows = () => db.$primary.select().from(Tasks).where(eq(Tasks.organizationId, organizationId))

for (const [id, full_name] of [[11, "acme/storefront"], [12, "acme/billing-api"], [13, "acme/docs"], [14, "acme/mobile-app"]] as const) github.addRepository({ id, full_name, default_branch: "main", private: id !== 13, archived: false })
const installation = { id: 51, account: { id: 7, login: "acme", type: "Organization" as const }, repository_selection: "selected" as const, suspended_at: null, html_url: `${github.url}/settings/installations/51`, repositoryIds: [11, 12] }
github.addInstallation(installation)
github.addInstallation({ ...installation, id: 52, repositoryIds: [13, 14] })
github.addUser({ id: 1, name: "Maya Chen", login: "maya-chen", installationIds: [51] })
github.addUser({ id: 2, name: "Sam Rivera", login: "sam-rivera", installationIds: [51] })
github.addUser({ id: 3, name: "Leo Martin", login: "leo-martin", installationIds: [52] })

async function authorize(call: typeof manage, id: number, kind: "install" | "link") {
  const begin = await call("POST", `${cloudPath}/github/${kind}/start`, kind === "install" ? { existing: true } : {})
  assert.equal(begin.status, 200, summary(begin))
  const redirect = new URL(cloudCodingRedirectSchema.parse(begin.body).redirectUrl)
  const state = redirect.searchParams.get("state")
  assert.ok(state)
  const result = await call("POST", `${cloudPath}/github/callback`, { state, code: github.issueCode(id) })
  assert.equal(result.status, 200, summary(result))
  assert.equal(cloudCodingGithubCallbackResultSchema.parse(result.body).outcome, kind === "link" ? "linked" : "connected")
}

function expectError(result: McpToolResult, error: string, message?: string) {
  assert.equal(result.status, 200, result.raw)
  assert.equal(result.isError, true, result.raw)
  assert.equal(field(result.body, "error"), error, result.raw)
  if (message !== undefined) assert.equal(field(result.body, "message"), message)
}

async function blocked(error: string, message: string, actor?: "member" | "organization_admin", token = mayaToken) {
  for (const result of [await start(startArgs, token), await execute("repositories", {}, token)]) {
    expectError(result, error, message)
    assert.equal(field(result.body, "ok"), false)
    if (actor) {
      const status = openworkCloudMcpConnectionActionSchema.parse(field(result.body, "connectionStatus"))
      const surface = actor === "member" ? "openwork_your_connections" : "openwork_organization_connections"
      const url = actor === "member" ? `${webPath}/link` : webPath
      assert.deepEqual(status, {
        version: 1, kind: "connection_action", source: "openwork-cloud", connectionId: "github-cloud-coding", connectionName: "GitHub",
        authType: "oauth", credentialMode: actor === "member" ? "per_member" : "shared", state: "needs_connection", actor,
        action: { type: "connect", surface, retry: "search_capabilities" },
      })
      assert.equal(field(result.body, actor === "member" ? "linkUrl" : "setupUrl"), url)
      assert.deepEqual(connectionActionPayloadSchema.parse(result.structured).action, { type: "connect", surface, label: "Connect GitHub", url })
      assert.match(result.raw, /openwork\/mcpApp/)
      if (actor === "member") assert.match(String(field(result.body, "note")), /native connection question/)
    } else {
      assert.equal(field(result.body, "connectionStatus"), undefined)
      assert.equal(field(result.body, "retryable"), false)
    }
  }
  assert.equal((await taskRows()).length, 0)
}

test("feature-off hides all three capabilities; feature-on routes everyday requests and repository names", async () => {
  assert.equal((await search("cloud coding")).some(match => match.name.startsWith("cloud-coding:")), false)
  for (const action of ["start", "status", "repositories"]) expectError(await execute(action), "unknown_capability")
  assert.equal((await den.setFeature(maya.orgId, "cloudCoding", true)).status, 200)
  for (const query of ["fix a bug in the storefront repo and open a pull request", "change code", "open a PR", "commit", "branch"]) {
    assert.ok((await search(query)).some(match => match.name === "cloud-coding:start" && match.readOnly === false), query)
  }
})

test("readiness blockers return connection actions or the exact reason without starting a task", async () => {
  const configuredAppId = env.githubCloudCodingApp.appId
  env.githubCloudCodingApp.appId = undefined
  try {
    await blocked("not_configured", "Cloud coding isn't set up on this deployment yet.")
  } finally {
    env.githubCloudCodingApp.appId = configuredAppId
  }
  await blocked("github_not_connected", "GitHub isn't connected for your organization yet. An admin can connect it from Cloud coding in OpenWork.", "organization_admin")
  await authorize(manage, 1, "install")
  assert.equal((await manage("PUT", settingsPath, { enabled: false })).status, 200)
  await blocked("turned_off", "Cloud coding is turned off for your organization. An admin can turn it on from Cloud coding in OpenWork.")
  assert.equal((await manage("PUT", settingsPath, { enabled: true, access: { orgWide: false, memberIds: [], teamIds: [] } })).status, 200)
  await blocked("not_allowed", "You're not included in Cloud coding yet. Ask an admin to add you.")
  assert.equal((await manage("PUT", settingsPath, { access: { orgWide: true, memberIds: [], teamIds: [] } })).status, 200)
  await db.update(Installations).set({ suspendedAt: new Date() }).where(eq(Installations.organizationId, organizationId))
  await blocked("github_suspended", "GitHub paused OpenWork's access. An admin can resume it on GitHub.")
  await db.update(Installations).set({ suspendedAt: null }).where(eq(Installations.organizationId, organizationId))
  await blocked("account_not_linked", "Link your GitHub account so the pull request opens in your name.", "member", samToken)
  await authorize(den.as(sam, maya.orgId), 2, "link")
  assert.ok((await search("storefront")).some(match => match.name === "cloud-coding:start"))
})

test("repository listing stays in the caller's organization", async () => {
  assert.equal((await den.setFeature(leo.orgId, "cloudCoding", true)).status, 200)
  const other = den.as(leo.owner, leo.orgId)
  await authorize(other, 3, "install")
  await authorize(other, 3, "link")
  assert.deepEqual((await execute("repositories")).body, { repositories: [
    { fullName: "acme/billing-api", defaultBranch: "main", private: true }, { fullName: "acme/storefront", defaultBranch: "main", private: true },
  ] })
  assert.deepEqual((await execute("repositories", {}, leoToken)).body, { repositories: [
    { fullName: "acme/docs", defaultBranch: "main", private: false }, { fullName: "acme/mobile-app", defaultBranch: "main", private: true },
  ] })
})

test("start refuses a read-only token and repositories that are unknown, archived or removed", async () => {
  const issued = await manage("POST", "/v1/mcp/token", { scopes: ["mcp:read"] })
  assert.equal(issued.status, 200, summary(issued))
  expectError(await start(startArgs, text(field(issued.body, "token"), "read-only token")), "insufficient_mcp_scope")
  const unknown = await start({ ...startArgs, repository: "acme/docs" })
  expectError(unknown, "repository_not_available")
  assert.match(String(field(unknown.body, "message")), /acme\/billing-api, acme\/storefront.*admin chooses repositories on GitHub/)
  const saved = github.state.repositories.get(11)
  assert.ok(saved)
  try {
    github.addRepository({ ...saved, archived: true })
    expectError(await start(), "repository_not_available")
    github.state.repositories.delete(11)
    expectError(await start(), "repository_not_available")
  } finally {
    github.addRepository(saved)
  }
  assert.equal((await taskRows()).length, 0)
})

const cloudInput = z.object({ target: z.literal("cloud"), title: z.string(), prompt: z.string() })
const sessionReceipt = { sessionId: "ses_storefront", workspaceId: "workspace_storefront", workerId: "worker_storefront", started: true }
const fakeResult = (structuredContent: Record<string, unknown>, isError = false) => ({ isError, structuredContent, content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }] })
const taskIdFrom = (result: McpToolResult) => text(field(result.body, "taskId"), "started task ID")
function codeFrom(prompt: string) {
  return text(/--code "(occ_setup_[A-Za-z0-9_-]+)"/.exec(prompt)?.[1], "setup code in kickoff")
}

test("start kicks off one cloud session with a redeemable code; status shows approval and pull request", async (t) => {
  t.after(() => setCloudCodingSessionStarterForTests(undefined))
  const prompts: string[] = []
  setCloudCodingSessionStarterForTests(async (input) => {
    assert.equal(input.action, "create")
    assert.equal(input.organizationId, organizationId)
    assert.equal(input.userId, maya.owner.userId)
    assert.equal(input.hasWriteScope, true)
    const body = cloudInput.parse(input.body)
    assert.equal(body.title, "Code change: acme/storefront")
    prompts.push(body.prompt)
    return fakeResult(sessionReceipt)
  })
  const repo = github.state.repositories.get(11)
  assert.ok(repo)
  github.addRepository({ ...repo, default_branch: "release" })
  t.after(() => github.addRepository(repo))
  const result = await start()
  assert.equal(result.isError, false, result.raw)
  const taskId = taskIdFrom(result)
  assert.deepEqual(result.body, { ok: true, taskId, sessionId: sessionReceipt.sessionId, repository: "acme/storefront", baseBranch: "release", status: "running", note: field(result.body, "note") })
  assert.equal(prompts.length, 1)
  const prompt = prompts[0] ?? ""
  assert.ok(prompt.includes(`${env.apiPublicUrl}/v1/cloud-coding/gateway/helper.mjs`))
  assert.ok(prompt.includes(task))
  const code = codeFrom(prompt)
  const redeemed = await redeemCloudCodingSetupCode({ code })
  assert.equal(redeemed?.task.id, taskId)
  assert.equal(result.raw.includes(code), false)
  const storage = await den.auditStorageText()
  assert.match(storage, /cloud_coding\.task\.started/)
  assert.equal(storage.includes(code), false)
  assert.equal(storage.includes(task), false)
  const [row] = await taskRows()
  assert.ok(row)
  assert.equal(row.id, taskId)
  assert.equal(row.orgMembershipId, maya.owner.memberId)
  assert.equal(row.remoteSessionId, sessionReceipt.sessionId)
  assert.equal(row.workerId, sessionReceipt.workerId)
  assert.equal(row.title, task)
  const status = () => execute("status", { taskId })
  const before = await status()
  assert.equal(field(before.body, "approval"), null)
  assert.equal(field(before.body, "pullRequest"), null)
  assert.equal(field(before.body, "sessionId"), sessionReceipt.sessionId)
  const id = createDenTypeId("cloudCodingPushApproval")
  const sha = "a".repeat(40)
  const tests = { status: "passed" as const, command: "pnpm test", summary: "Checkout tests passed." }
  const branch = "openwork/fix-checkout"
  await db.insert(Approvals).values({ id, organizationId, orgMembershipId: row.orgMembershipId, taskId: row.id,
    githubRepositoryId: 11, repositoryFullName: row.repositoryFullName, branch, baseBranch: row.baseBranch, baseSha: sha, treeSha: sha, headSha: sha,
    commitTime: 1, authorName: "Maya Chen", authorEmail: "maya-chen@users.noreply.github.com", commitMessage: task, title: task,
    summary: { files: [{ path: "checkout.ts", change: "modified" }], fileCount: 1, tests }, expiresAt: new Date(Date.now() + 60_000),
  })
  const approvalUrl = `${webPath}/approvals/${id}`
  const pending = await status()
  assert.deepEqual(field(pending.body, "approval"), { id, status: "pending", branch, headSha: sha, fileCount: 1, tests, approvalUrl })
  assert.ok(String(field(pending.body, "note")).includes(approvalUrl))
  await db.update(Approvals).set({ status: "denied" }).where(eq(Approvals.id, id))
  assert.match(String(field((await status()).body, "note")), /Nothing was pushed/)
  await db.update(Approvals).set({ status: "pushed" }).where(eq(Approvals.id, id))
  const url = "https://github.com/acme/storefront/pull/9"
  await db.insert(PullRequests).values({ id: createDenTypeId("cloudCodingPullRequest"), organizationId, openedByOrgMembershipId: row.orgMembershipId,
    openedByName: "Maya Chen", approvalId: id, taskId: row.id, githubRepositoryId: 11, repositoryFullName: row.repositoryFullName, number: 9, title: task, url, branch, headSha: sha,
  })
  const opened = await status()
  assert.deepEqual(field(opened.body, "pullRequest"), { number: 9, url, state: "open" })
  assert.ok(String(field(opened.body, "note")).includes(url))
  expectError(await execute("status", { taskId }, samToken), "task_not_found")
})

test("provisioning retry reuses the task and rotates the setup code; no other member can continue it", async (t) => {
  t.after(() => setCloudCodingSessionStarterForTests(undefined))
  const codes: string[] = []
  const provisioning = { error: "cloud_runtime_provisioning", message: "Your cloud computer is getting ready.", retryable: true, retryAfterMs: 30_000 }
  setCloudCodingSessionStarterForTests(async ({ body }) => {
    codes.push(codeFrom(cloudInput.parse(body).prompt))
    return codes.length === 1 ? fakeResult(provisioning, true) : fakeResult(sessionReceipt)
  })
  const count = (await taskRows()).length
  const initial = await start({ ...startArgs, baseBranch: "main", title: "Fix checkout rounding" })
  expectError(initial, provisioning.error, provisioning.message)
  const taskId = taskIdFrom(initial)
  assert.equal(field(initial.body, "retryable"), true)
  assert.equal(field(initial.body, "retryAfterMs"), 30_000)
  assert.match(String(field(initial.body, "note")), /this taskId in about 30 seconds/)
  assert.equal((await taskRows()).find(row => row.id === taskId)?.status, "created")
  expectError(await start({ ...startArgs, taskId }, samToken), "task_not_found")
  const retried = await start({ ...startArgs, taskId })
  assert.equal(retried.isError, false, retried.raw)
  assert.equal(taskIdFrom(retried), taskId)
  assert.equal((await taskRows()).length, count + 1)
  const [first, second] = codes
  assert.ok(first && second && first !== second)
  assert.equal(await redeemCloudCodingSetupCode({ code: first }), null)
  assert.equal(initial.raw.includes(first) || retried.raw.includes(second), false)
  const repeated = await start({ ...startArgs, taskId })
  assert.equal(field(repeated.body, "status"), "running")
  assert.equal(codes.length, 2)
  assert.equal((await redeemCloudCodingSetupCode({ code: second }))?.task.id, taskId)
})

test("a non-provisioning runtime error marks the task failed without repeating runtime internals", async (t) => {
  t.after(() => setCloudCodingSessionStarterForTests(undefined))
  setCloudCodingSessionStarterForTests(async ({ body }) => fakeResult({ error: "remote_session_request_failed", retryable: true, message: cloudInput.parse(body).prompt }, true))
  const result = await start()
  expectError(result, "remote_session_request_failed", "OpenWork couldn't start the code change on your cloud computer.")
  const row = (await taskRows()).find(item => item.id === taskIdFrom(result))
  assert.equal(row?.status, "failed")
  assert.equal(row?.failureCode, "remote_session_request_failed")
  assert.equal(result.raw.includes("occ_setup_"), false)
})
