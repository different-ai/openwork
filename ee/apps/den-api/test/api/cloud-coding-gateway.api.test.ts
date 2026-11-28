import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { promisify } from "node:util"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { CloudCodingPushApprovalTable as Approvals, CloudCodingGithubLinkTable as Links, AuditEventTable, AuditOperationTable, AuditEventResourceTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { CLOUD_CODING_MAX_CHANGED_FILES, CLOUD_CODING_MAX_FILE_BYTES, cloudCodingGatewaySetupSchema, cloudCodingGatewayTaskSchema, cloudCodingOpenedPullRequestSchema, cloudCodingOverviewSchema, cloudCodingPushApprovalListSchema, cloudCodingPushApprovalSchema, cloudCodingPushResultSchema, cloudCodingReadTokenSchema } from "@openwork/types/den/cloud-coding"
import { z } from "zod"
import { startFakeGithubGit } from "./cloud-coding-fake-github-git.js"
import { bootDen, field, summary, type Call, type Method } from "./harness.js"

const github = await startFakeGithubGit()
after(() => github.close())
const den = await bootDen({ env: { ...github.env, DEN_DEPLOYMENT: "cloud", DEN_AUDIT_CAPTURE_ENABLED: "true", DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(() => den.close())
const { createCloudCodingTask } = await import("../../src/cloud-coding/tasks.js")
const { findCloudCodingRepository } = await import("../../src/cloud-coding/installation.js")
const { db } = await import("../../src/db.js")
const root = "/v1/cloud-coding"
const gateway = `${root}/gateway`
const approvals = `${root}/approvals`
const fullName = "acme/storefront"
const initial = { "README.md": "Original\n", "src/keep.ts": "keep\n", "src/remove.ts": "remove\n", "LICENSE": "license\n" }
const baseSha = await github.seedRepository(fullName, initial)
await github.seedRepository("acme/billing-api", initial)
const repoRecord = { id: 11, full_name: fullName, default_branch: "main", private: true, archived: false }
github.addRepository(repoRecord)
github.addRepository({ ...repoRecord, id: 12, full_name: "acme/billing-api" })
github.addRepository({ ...repoRecord, id: 13, full_name: "acme/docs" })
const installation = { id: 51, account: { id: 71, login: "acme", type: "Organization" as const }, repository_selection: "selected" as const, suspended_at: null, html_url: `${github.url}/settings/installations/51`, repositoryIds: [11, 12] }
github.addInstallation(installation)
github.addInstallation({ ...installation, id: 52, account: { ...installation.account, id: 72 }, repositoryIds: [13] })
const mayaGithub = { id: 1, login: "maya-chen", name: "Maya Chen", installationIds: [51], writableRepositoryIds: [11] }
github.addUser(mayaGithub)
github.addUser({ id: 2, login: "sam-rivera", name: "Sam Rivera", installationIds: [51], writableRepositoryIds: [11] })
github.addUser({ id: 3, login: "leo-martin", name: "Leo Martin", installationIds: [52], writableRepositoryIds: [13] })
const owner = await den.signUp("Maya Chen", "maya@acme.dev")
const org = await den.createOrg(owner, "Acme Corp")
const sam = await den.newMember(owner, org.orgId, "Sam Rivera")
const other = await den.createOrg(await den.signUp("Leo Martin"), "Acme Corp")
const own = den.as(org.owner, org.orgId)
const asSam = den.as(sam, org.orgId)
const asLeo = den.as(other.owner, other.orgId)
const organizationId = normalizeDenTypeId("organization", org.orgId)

function status(result: Call, code: number) {
  assert.equal(result.status, code, summary(result))
  return result.body
}
function refuses(result: Call, code: number, error: string) {
  assert.equal(field(status(result, code), "error"), error)
  assert.equal(typeof field(result.body, "message"), "string")
  assert.equal(result.headers.get("cache-control"), "no-store")
}
async function connect(call: typeof own, githubId: number, installationId?: number) {
  const start = installationId ? await call("POST", `${root}/github/install/start`, {}) : await call("POST", `${root}/github/link/start`)
  const url = new URL(z.string().parse(field(status(start, 200), "redirectUrl")))
  const done = await call("POST", `${root}/github/callback`, { state: url.searchParams.get("state"), code: github.issueCode(githubId), installationId })
  assert.equal(field(status(done, 200), "outcome"), installationId ? "connected" : "linked")
}
for (const id of [org.orgId, other.orgId]) status(await den.setFeature(id, "cloudCoding", true), 200)
await connect(own, 1, 51)
await connect(asSam, 2)
await connect(asLeo, 3, 52)
const repository = await findCloudCodingRepository({ organizationId, fullName })
assert.ok(repository)
const storefront = repository

const visibleBodies: unknown[] = []
const taskTokens: string[] = []
const setupCodes: string[] = []
function save(result: Call, containsToken = false) {
  if (containsToken && result.status === 200) {
    const { token, ...visible } = z.object({ token: z.string() }).passthrough().parse(result.body)
    assert.ok(token)
    visibleBodies.push(visible)
  } else visibleBodies.push(result.body)
  return result
}
async function newTask(member = org.owner, orgId = organizationId, repo = storefront) {
  const task = await createCloudCodingTask({ organizationId: orgId, memberId: normalizeDenTypeId("member", member.memberId), repository: repo, baseBranch: "main", title: "Update storefront",
    origin: { surface: "web", conversationId: null, runTokenId: null, runnerMessageId: null, workerId: null } })
  setupCodes.push(task.setupCode)
  const setup = save(await den.request(null, "POST", `${gateway}/setup`, { body: { code: task.setupCode } }), true)
  const { token } = cloudCodingGatewaySetupSchema.parse(status(setup, 200))
  taskTokens.push(token)
  const call = async (method: Method, path: string, body?: unknown) => save(await den.request(token, method, `${gateway}${path}`, { body }), path === "/read-token")
  return { ...task, token, call }
}
const file = (path: string, contents: string) => ({ path, mode: "100644", contentBase64: Buffer.from(contents).toString("base64") })
const changedFiles = [file("README.md", "Updated\n"), file("src/new.ts", "new\n"), { path: "src/remove.ts", deleted: true }]
const tests = { status: "passed", command: "pnpm test", summary: "All checks passed" }
const change = (branch: string) => ({ branch, baseSha, commitMessage: "Update storefront\r\n\r\nAdd the new page.  \r\n", files: changedFiles })
type Task = Awaited<ReturnType<typeof newTask>>
const ask = (task: Task, changeSet: unknown) => task.call("POST", "/push-approvals", { changeSet, title: "Update storefront", body: "Add the new page.", tests })
const push = (task: Task, id: string, changeSet: unknown) => task.call("POST", `/push-approvals/${id}/push`, { changeSet })
const decision = async (id: string, decision = "allow_once", caller = own) => save(await caller("POST", `${approvals}/${id}/decision`, { decision }))
const open = (task: Task, approvalId: string) => task.call("POST", "/pull-requests", { approvalId })
const envelope = z.object({ approval: cloudCodingPushApprovalSchema })
const refWrites = () => github.writes.filter(row => row.path.endsWith("/git/refs")).length
async function requested(task: Task, changeSet: unknown) {
  return envelope.parse(status(await ask(task, changeSet), 201)).approval
}
async function approved(branch: string, task?: Task) {
  const current = task ?? await newTask()
  const changeSet = change(branch)
  const approval = await requested(current, changeSet)
  assert.equal(cloudCodingPushApprovalSchema.parse(status(await decision(approval.id), 200)).status, "approved")
  return { current, approval, changeSet }
}

const captured: string[] = []
const intercept = (stream: typeof process.stdout) => {
  const original = stream.write.bind(stream)
  stream.write = (chunk: Uint8Array | string, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    captured.push(chunk.toString())
    return typeof encodingOrCallback === "string" ? original(chunk, encodingOrCallback, callback) : original(chunk, encodingOrCallback)
  }
  return () => { stream.write = original }
}
const restoreOut = intercept(process.stdout)
const restoreErr = intercept(process.stderr)
after(() => { restoreOut(); restoreErr() })

test("setup, read-only clone, signed-in decision, exact Git commit and one pull request", async () => {
  const task = await newTask()
  const repeated = save(await den.request(null, "POST", `${gateway}/setup`, { body: { code: task.setupCode } }))
  refuses(repeated, 401, "task_closed")
  assert.equal(field(repeated.body, "message"), "This setup code was already used or has expired. Ask OpenWork to start the task again.")
  const details = cloudCodingGatewayTaskSchema.parse(status(await task.call("GET", "/task"), 200))
  assert.deepEqual(details.author, { name: "Maya Chen", email: "1+maya-chen@users.noreply.github.com", login: "maya-chen" })
  const read = cloudCodingReadTokenSchema.parse(status(await task.call("POST", "/read-token"), 200))
  assert.deepEqual(github.state.installationTokens.get(read.token)?.repositoryIds, [11])
  assert.deepEqual(github.state.installationTokens.get(read.token)?.permissions, { contents: "read", metadata: "read" })
  const auth = { authorization: `Bearer ${read.token}` }
  assert.equal((await fetch(`${github.url}/repositories/12`, { headers: auth })).status, 404)
  assert.equal((await fetch(`${github.url}/repos/${fullName}/git/refs`, { method: "POST", headers: auth, body: JSON.stringify({ ref: "refs/heads/not-allowed", sha: baseSha }) })).status, 403)
  assert.deepEqual(github.writes.pop(), { kind: "installation", path: `/repos/${fullName}/git/refs` })
  const cloneDir = await mkdtemp(join(tmpdir(), "cloud-coding-clone-"))
  try {
    const basic = `Basic ${Buffer.from(`x-access-token:${read.token}`).toString("base64")}`
    assert.equal((await fetch(`${github.url}/acme/billing-api.git/info/refs?service=git-upload-pack`, { headers: { authorization: basic } })).status, 401)
    const exec = promisify(execFile)
    await exec("git", ["-c", `http.extraHeader=Authorization: ${basic}`, "clone", read.cloneUrl, cloneDir])
    assert.equal((await exec("git", ["-C", cloneDir, "rev-parse", "HEAD"])).stdout.trim(), baseSha)
  } finally { await rm(cloneDir, { recursive: true, force: true }) }
  const changeSet = change("openwork/update-storefront")
  const approval = await requested(task, changeSet)
  assert.equal(approval.status, "pending")
  assert.equal(approval.branch, changeSet.branch)
  assert.equal(approval.baseBranch, "main")
  assert.equal(approval.fileCount, 3)
  assert.deepEqual(approval.files, [{ path: "README.md", change: "modified" }, { path: "src/new.ts", change: "added" }, { path: "src/remove.ts", change: "deleted" }])
  assert.deepEqual(approval.tests, tests)
  assert.deepEqual(github.writes, [])
  const waiting = task.call("GET", `/push-approvals/${approval.id}?waitMs=4000`)
  await sleep(150)
  assert.equal(cloudCodingPushApprovalSchema.parse(status(await decision(approval.id), 200)).status, "approved")
  assert.equal(envelope.parse(status(await waiting, 200)).approval.status, "approved")
  assert.deepEqual(github.writes, [])
  const pushed = cloudCodingPushResultSchema.parse(status(await push(task, approval.id, changeSet), 200))
  assert.equal(pushed.headSha, approval.headSha)
  const commit = await github.readBranch(fullName, changeSet.branch)
  assert.ok(commit)
  assert.equal(commit.sha, approval.headSha)
  assert.equal(commit.parent, baseSha)
  assert.match(commit.author ?? "", /^Maya Chen <1\+maya-chen@users\.noreply\.github\.com> \d+ \+0000$/)
  assert.equal(commit.committer, commit.author)
  assert.equal(commit.message, "Update storefront\n\nAdd the new page.\n")
  assert.deepEqual(Object.fromEntries(commit.files.map(row => [row.path, row.contents.toString()])), { "LICENSE": "license\n", "README.md": "Updated\n", "src/keep.ts": "keep\n", "src/new.ts": "new\n" })
  const pr = cloudCodingOpenedPullRequestSchema.parse(status(await open(task, approval.id), 200))
  assert.deepEqual(cloudCodingOpenedPullRequestSchema.parse(status(await open(task, approval.id), 200)), pr)
  status(await task.call("GET", "/task"), 200)
  refuses(await task.call("POST", "/read-token"), 401, "task_closed")
  assert.deepEqual(github.writes.filter(row => row.path.endsWith("/pulls")), [{ kind: "user", path: `/repos/${fullName}/pulls` }])
  assert.equal(github.pulls.get(fullName)?.[0]?.user.login, "maya-chen")
  const overview = cloudCodingOverviewSchema.parse(status(save(await own("GET", root)), 200))
  const item = overview.pullRequests.find(item => item.number === pr.number)
  assert.deepEqual(item?.openedBy, { name: "Maya Chen", memberId: org.owner.memberId })
  assert.equal(item?.url, pr.url)
  const detail = cloudCodingPushApprovalSchema.parse(status(save(await own("GET", `${approvals}/${approval.id}`)), 200))
  assert.deepEqual(detail.pullRequest, { number: pr.number, url: pr.url, state: "open" })
})

const refusalInputs = [
  ["default_branch_refused", 409, change("main")],
  ["invalid_branch", 422, change("refs/heads/x")],
  ["invalid_branch", 422, change("a..b")],
  ["workflow_files_refused", 422, { ...change("workflow"), files: [file(".github/workflows/test.yml", "test")] }],
  ["path_refused", 422, { ...change("path"), files: [file("../README.md", "test")] }],
  ["path_refused", 422, { ...change("path"), files: [file(".git/config", "test")] }],
  ["file_mode_refused", 422, { ...change("symlink"), files: [{ ...file("link", "README.md"), mode: "120000" }] }],
  ["file_mode_refused", 422, { ...change("base64"), files: [{ ...file("README.md", "x"), contentBase64: "eA" }] }],
  ["change_too_large", 422, { ...change("file-count"), files: Array.from({ length: CLOUD_CODING_MAX_CHANGED_FILES + 1 }, (_, i) => file(`${i}.txt`, "a")) }],
  ["change_too_large", 422, { ...change("file-size"), files: [file("large", "a".repeat(CLOUD_CODING_MAX_FILE_BYTES + 1))] }],
  ["no_changes", 422, { ...change("unchanged"), files: [file("README.md", initial["README.md"])] }],
  ["base_not_found", 422, { ...change("missing-base"), baseSha: "0".repeat(40) }],
] as const

for (const [index, [error, code, changeSet]] of refusalInputs.entries()) {
  test(`refuses invalid change ${index + 1}: ${error}`, async () => {
    const before = refWrites()
    refuses(await ask(await newTask(), changeSet), code, error)
    assert.equal(refWrites(), before)
  })
}

test("refuses an existing branch when asked or after approval", async () => {
  const before = refWrites()
  await github.createBranch(fullName, "already-exists", baseSha)
  refuses(await ask(await newTask(), change("already-exists")), 409, "branch_exists")
  const { current, approval, changeSet } = await approved("appeared-after-approval")
  await github.createBranch(fullName, changeSet.branch, baseSha)
  refuses(await push(current, approval.id, changeSet), 409, "branch_exists")
  assert.equal(refWrites(), before)
})

for (const state of ["pending", "denied", "expired", "superseded"] as const) {
  test(`refuses a ${state} approval`, async () => {
    const current = await newTask()
    const changeSet = change(`openwork/${state}`)
    const approval = await requested(current, changeSet)
    if (state === "denied") status(await decision(approval.id, "deny"), 200)
    if (state === "expired") await db.update(Approvals).set({ expiresAt: new Date(Date.now() - 5000) }).where(eq(Approvals.id, normalizeDenTypeId("cloudCodingPushApproval", approval.id)))
    if (state === "superseded") await requested(current, change(`openwork/replaces-${state}`))
    const before = refWrites()
    if (state === "denied") {
      refuses(await push(current, approval.id, changeSet), 401, "task_closed")
      refuses(await ask(current, changeSet), 401, "task_closed")
      refuses(await open(current, approval.id), 401, "task_closed")
      assert.equal(envelope.parse(status(await current.call("GET", `/push-approvals/${approval.id}?waitMs=10`), 200)).approval.status, "denied")
      status(await current.call("GET", "/task"), 200)
    } else {
      refuses(await push(current, approval.id, changeSet), 409, state === "superseded" ? "approval_used" : `approval_${state}`)
    }
    assert.equal(refWrites(), before)
    if (state === "expired") {
      const [row] = await db.$primary.select().from(Approvals).where(eq(Approvals.id, normalizeDenTypeId("cloudCodingPushApproval", approval.id)))
      assert.equal(row?.status, "expired")
    }
  })
}

for (const key of ["files", "branch", "baseSha", "commitMessage"] as const) {
  test(`refuses a different ${key} after approval`, async () => {
    const { current, approval, changeSet } = await approved(`openwork/mismatch-${key}`)
    const before = refWrites()
    const different = { files: [file("README.md", "different")], branch: "different", baseSha: "0".repeat(40), commitMessage: "Different" }[key]
    refuses(await push(current, approval.id, { ...changeSet, [key]: different }), 422, "commit_mismatch")
    assert.equal(refWrites(), before)
  })
}

test("used approval never recreates a removed branch", async () => {
  const { current, approval, changeSet } = await approved("openwork/used")
  status(await push(current, approval.id, changeSet), 200)
  await github.deleteBranch(fullName, changeSet.branch)
  const before = refWrites()
  refuses(await push(current, approval.id, changeSet), 409, "approval_used")
  assert.equal(refWrites(), before)
})

for (const restriction of ["repository removed", "repository archived", "feature disabled", "turned off", "not allowed", "account unlinked"] as const) {
  test(`rechecks the live gateway permission: ${restriction}`, async () => {
    const { current, approval, changeSet } = await approved(`openwork/recheck-${restriction.replace(" ", "-")}`)
    const before = refWrites()
    let reset: () => unknown = () => undefined
    let error: string
    try {
      switch (restriction) {
        case "repository removed":
          github.addInstallation({ ...installation, repositoryIds: [12] })
          reset = () => github.addInstallation(installation)
          error = "repository_not_available"
          break
        case "repository archived":
          github.addRepository({ ...repoRecord, archived: true })
          reset = () => github.addRepository(repoRecord)
          error = "repository_not_available"
          break
        case "feature disabled":
          status(await den.setFeature(org.orgId, "cloudCoding", false), 200)
          reset = async () => status(await den.setFeature(org.orgId, "cloudCoding", true), 200)
          error = "feature_disabled"
          break
        case "turned off":
          status(await own("PUT", `${root}/settings`, { enabled: false }), 200)
          reset = async () => status(await own("PUT", `${root}/settings`, { enabled: true }), 200)
          error = "turned_off"
          break
        case "not allowed":
          status(await own("PUT", `${root}/settings`, { access: { orgWide: false, memberIds: [sam.memberId], teamIds: [] } }), 200)
          reset = async () => status(await own("PUT", `${root}/settings`, { access: { orgWide: true, memberIds: [], teamIds: [] } }), 200)
          error = "not_allowed"
          break
        case "account unlinked":
          await db.delete(Links).where(and(eq(Links.organizationId, organizationId), eq(Links.orgMembershipId, normalizeDenTypeId("member", org.owner.memberId))))
          reset = () => connect(own, 1)
          error = "account_not_linked"
          break
      }
      refuses(await push(current, approval.id, changeSet), 403, error)
      assert.equal(refWrites(), before)
    } finally { await reset() }
  })
}

test("github without write access or with unexpected blob SHA cannot create a ref", async () => {
  const { current, approval, changeSet } = await approved("openwork/no-write")
  const before = refWrites()
  github.addUser({ ...mayaGithub, writableRepositoryIds: [] })
  try {
    refuses(await push(current, approval.id, changeSet), 502, "github_refused")
    assert.equal(envelope.parse(status(await current.call("GET", `/push-approvals/${approval.id}`), 200)).approval.status, "approved")
    assert.equal(refWrites(), before)
  } finally { github.addUser(mayaGithub) }
  github.faults.wrongNextBlobSha = true
  refuses(await push(current, approval.id, changeSet), 422, "commit_mismatch")
  assert.equal(envelope.parse(status(await current.call("GET", `/push-approvals/${approval.id}`), 200)).approval.status, "approved")
  assert.equal(refWrites(), before)
})

test("approval isolation, only a session can decide, retries deduplicate and newer requests supersede", async () => {
  const current = await newTask()
  const anotherTask = await newTask()
  const samTask = await newTask(sam)
  const otherId = normalizeDenTypeId("organization", other.orgId)
  const repo = await findCloudCodingRepository({ organizationId: otherId, fullName: "acme/docs" })
  assert.ok(repo)
  const leoTask = await newTask(other.owner, otherId, repo)
  const changeSet = change("openwork/approval-scope")
  const approval = await requested(current, changeSet)
  assert.equal((await requested(current, changeSet)).id, approval.id)
  const before = refWrites()
  for (const task of [anotherTask, samTask, leoTask]) refuses(await push(task, approval.id, changeSet), 404, "approval_not_found")
  for (const caller of [asSam, asLeo]) {
    refuses(save(await caller("GET", `${approvals}/${approval.id}`)), 404, "approval_not_found")
    refuses(await decision(approval.id, "allow_once", caller), 404, "approval_not_found")
    assert.deepEqual(cloudCodingPushApprovalListSchema.parse(status(save(await caller("GET", `${approvals}?status=pending`)), 200)).approvals, [])
  }
  const apiKey = await own("POST", "/v1/api-keys", { name: "Cloud coding test" })
  status(apiKey, 201)
  const secret = z.string().parse(field(apiKey.body, "key") ?? field(apiKey.body, "apiKey", "key"))
  const apiDecision = await den.request(null, "POST", `${approvals}/${approval.id}/decision`, { orgId: org.orgId, headers: { "x-api-key": secret }, body: { decision: "allow_once" } })
  assert.ok([401, 403].includes(apiDecision.status), summary(apiDecision))
  status(await den.request(current.token, "POST", `${approvals}/${approval.id}/decision`, { orgId: org.orgId, body: { decision: "allow_once" } }), 401)
  const replacement = await requested(current, change("openwork/replacement"))
  assert.notEqual(replacement.id, approval.id)
  assert.equal(cloudCodingPushApprovalSchema.parse(status(save(await own("GET", `${approvals}/${approval.id}`)), 200)).status, "superseded")
  status(await decision(replacement.id), 200)
  refuses(await decision(replacement.id), 409, "approval_not_pending")
  assert.equal(refWrites(), before)
})

test("removal ends the member's task", async () => {
  const current = await newTask(sam)
  const changeSet = change("openwork/member-removed")
  const approval = await requested(current, changeSet)
  status(await decision(approval.id, "allow_once", asSam), 200)
  const removal = await own("DELETE", `/v1/members/${sam.memberId}`)
  assert.ok([200, 204].includes(removal.status), summary(removal))
  const before = refWrites()
  refuses(await push(current, approval.id, changeSet), 401, "task_closed")
  refuses(await current.call("POST", "/read-token"), 401, "task_closed")
  assert.equal(refWrites(), before)
})

test("two concurrent pushes create exactly one ref", async () => {
  const { current, approval, changeSet } = await approved("openwork/concurrent")
  const before = refWrites()
  const answers = await Promise.all([push(current, approval.id, changeSet), push(current, approval.id, changeSet)])
  assert.ok(answers.some(result => result.status === 200), answers.map(summary).join("; "))
  for (const result of answers) {
    if (result.status === 200) assert.equal(cloudCodingPushResultSchema.parse(result.body).headSha, approval.headSha)
    else refuses(result, 409, "approval_used")
  }
  assert.equal(refWrites(), before + 1)
})

test("a lost ref response is resolved by checking the existing branch", async () => {
  const { current, approval, changeSet } = await approved("openwork/lost-response")
  const before = refWrites()
  github.faults.loseNextRefResponse = true
  refuses(await push(current, approval.id, changeSet), 502, "github_refused")
  assert.equal(cloudCodingPushResultSchema.parse(status(await push(current, approval.id, changeSet), 200)).headSha, approval.headSha)
  assert.equal(refWrites(), before + 1)
})

test("audit rows, logs, and non-token response fields contain no credentials", async () => {
  const rows = await db.$primary.select().from(AuditEventTable).where(eq(AuditEventTable.org_id, organizationId))
  const resources = await db.$primary.select().from(AuditEventResourceTable).where(eq(AuditEventResourceTable.organization_id, organizationId))
  const operations = await db.$primary.select().from(AuditOperationTable).where(eq(AuditOperationTable.organization_id, organizationId))
  for (const action of ["push.requested", "push.approved", "push.denied", "push.completed", "push.refused", "pull_request.opened"]) assert.ok(rows.some(row => row.action === `cloud_coding.${action}`), action)
  assert.ok(rows.some(row => row.action === "cloud_coding.push.refused" && row.envelope?.reasonCode === "commit_mismatch"))
  assert.ok(operations.some(row => row.kind === "cloud_coding.gateway" && row.initiating_actor.memberId === org.owner.memberId))
  const output = JSON.stringify({ rows, resources, operations, visibleBodies, captured })
  for (const token of [...setupCodes, ...taskTokens, ...github.state.installationTokens.keys(), ...github.state.revoked, ...[...github.state.userTokens.values()].flatMap(row => [row.accessToken, row.refreshToken])]) assert.equal(output.includes(token), false, "A credential escaped its intended field")
})

test("release disposes the credential and may be repeated", async () => {
  const current = await newTask()
  status(await current.call("POST", "/release"), 204)
  status(await current.call("POST", "/release"), 204)
  refuses(await current.call("GET", "/task"), 401, "task_closed")
})
