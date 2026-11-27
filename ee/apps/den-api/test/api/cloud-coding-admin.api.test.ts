import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { after, test } from "node:test"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { cloudCodingGithubCallbackResultSchema, cloudCodingOverviewSchema, cloudCodingRedirectSchema } from "@openwork/types/den/cloud-coding"
import { CloudCodingPullRequestTable } from "@openwork-ee/den-db/schema"
import { z } from "zod"
import { bootDen, field, summary } from "./harness.js"
import { startFakeGithub } from "./cloud-coding-fake-github.js"

const github = await startFakeGithub()
after(() => github.close())
const den = await bootDen({ env: { ...github.env, DEN_DEPLOYMENT: "cloud", DEN_AUDIT_CAPTURE_ENABLED: "true", DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(() => den.close())
const { getCloudCodingReadiness } = await import("../../src/cloud-coding/access.js")
const { getMemberGithubAccessToken } = await import("../../src/cloud-coding/links.js")
const { createRepositoryReadToken, findCloudCodingRepository } = await import("../../src/cloud-coding/installation.js")
const { client, db } = await import("../../src/db.js")
const root = "/v1/cloud-coding"
const owner = await den.signUp("Maya Chen", "maya@acme.dev")
const first = await den.createOrg(owner, "Acme Corp")
const sam = await den.newMember(owner, first.orgId, "Sam Rivera")
const leo = await den.newMember(owner, first.orgId, "Leo Martin", "admin")
const arjun = await den.newMember(owner, first.orgId, "Arjun Patel")
const second = await den.createOrg(leo, "Acme Corp")
for (const org of [first, second]) assert.equal((await den.setFeature(org.orgId, "cloudCoding", true)).status, 200)
const manage = den.as(first.owner, first.orgId)
const member = den.as(sam, first.orgId)
const other = den.as(second.owner, second.orgId)
const scope = (person: { memberId: string; userId: string }) => ({ organizationId: normalizeDenTypeId("organization", first.orgId), memberId: normalizeDenTypeId("member", person.memberId), userId: person.userId })
const organizationId = scope(first.owner).organizationId
for (const [id, full_name] of [[11, "acme/storefront"], [12, "acme/billing-api"], [13, "acme/docs"]] as const) github.addRepository({ id, full_name, default_branch: "main", private: true, archived: false })
const installation = { id: 51, account: { id: 7, login: "acme", type: "Organization" as const }, repository_selection: "selected" as const, suspended_at: null, html_url: `${github.url}/settings/installations/51`, repositoryIds: [11, 12] }
github.addInstallation(installation)
github.addInstallation({ ...installation, id: 52, repositoryIds: [13] })
github.state.pageSize = 1
for (const [id, name, login, installationIds] of [[1, "Maya Chen", "maya-chen", [51]], [2, "Sam Rivera", "sam-rivera", [51]], [3, "Leo Martin", "leo-martin", [51, 52]], [4, "Arjun Patel", "arjun-patel", [51]]] as const) github.addUser({ id, name, login, installationIds: [...installationIds] })

type Call = Awaited<ReturnType<typeof manage>>
function expectStatus(call: Call, status: number) {
  assert.equal(call.status, status, summary(call))
  return call
}
function redirect(call: Call) {
  return new URL(cloudCodingRedirectSchema.parse(expectStatus(call, 200).body).redirectUrl)
}
function view(call: Call) { return cloudCodingOverviewSchema.parse(expectStatus(call, 200).body) }
const callbackPath = `${root}/github/callback`
const { webUrl } = (await import("../../src/env.js")).env
const webCallback = `${webUrl}/dashboard/cloud-coding/github/callback`
const { createCloudCodingState } = await import("../../src/cloud-coding/state.js")

function stateFrom(start: Call) {
  const url = redirect(start)
  if (url.pathname === "/login/oauth/authorize") assert.equal(url.searchParams.get("redirect_uri"), webCallback)
  const state = url.searchParams.get("state")
  assert.ok(state)
  return state
}

function callback(call: typeof manage, start: Call, userId: number, installationId?: number) {
  return call("POST", callbackPath, { state: stateFrom(start), code: github.issueCode(userId), installationId })
}

function outcome(call: Call) {
  assert.equal(github.state.lastCodeExchangeRedirectUri, webCallback)
  return cloudCodingGithubCallbackResultSchema.parse(expectStatus(call, 200).body)
}
async function hook(event: string, body: object, valid = true) {
  const raw = JSON.stringify(body)
  const signature = `sha256=${createHmac("sha256", github.webhookSecret).update(valid ? raw : `${raw} `).digest("hex")}`
  return den.request(null, "POST", "/v1/webhooks/cloud-coding/github", { rawBody: raw, headers: { "x-github-event": event, "x-hub-signature-256": signature } })
}
async function rawLink(memberId: string) {
  if (!("getConnection" in client)) throw new Error("Expected MySQL.")
  const [rows] = await client.query("SELECT access_token, refresh_token FROM cloud_coding_github_link WHERE org_membership_id = ?", [memberId])
  return z.array(z.object({ access_token: z.string(), refresh_token: z.string() })).parse(rows)[0]
}

test("only managers connect, and the callback checks reachability and exclusive binding", async () => {
  assert.equal(view(await member("GET", root)).canManage, false)
  expectStatus(await member("PUT", `${root}/settings`, { enabled: false }), 403)
  expectStatus(await member("POST", `${root}/github/install/start`, {}), 403)
  assert.equal((await getCloudCodingReadiness(scope(sam))).readiness, "github_not_connected")
  const start = await manage("POST", `${root}/github/install/start`, { existing: true })
  const explicit = await manage("POST", `${root}/github/install/start`, {})
  const inferred = await manage("POST", `${root}/github/install/start`, { existing: true })
  assert.equal(field(expectStatus(await callback(manage, start, 1, 52), 403).body, "error"), "not_your_installation")
  assert.equal(view(await manage("GET", root)).connection, null)
  assert.equal(outcome(await callback(manage, explicit, 1, 51)).outcome, "connected")
  assert.equal(outcome(await callback(manage, inferred, 1)).outcome, "connected")
  assert.equal(redirect(await manage("POST", `${root}/github/install/start`, {})).searchParams.get("github"), "connected")
  assert.deepEqual(view(await manage("GET", root)).repositories.map(repo => repo.fullName), ["acme/billing-api", "acme/storefront"])
  assert.equal((await findCloudCodingRepository({ organizationId, fullName: "STOREFRONT" }))?.githubRepositoryId, 11)
  const token = await createRepositoryReadToken({ organizationId, githubRepositoryId: 11 })
  assert.ok(token)
  assert.deepEqual(github.state.installationTokens.get(token.token)?.permissions, { contents: "read", metadata: "read" })
  assert.equal((await fetch(`${github.url}/repositories/12`, { headers: { Authorization: `Bearer ${token.token}` } })).status, 404)
  const secondStart = await other("POST", `${root}/github/install/start`, { existing: true })
  const choose = await other("POST", `${root}/github/install/start`, { existing: true })
  const install = await other("POST", `${root}/github/install/start`, {})
  const initialState = stateFrom(install)
  github.addUser({ id: 3, name: "Leo Martin", login: "leo-martin", installationIds: [] })
  const result = outcome(await callback(other, install, 3))
  assert.equal(result.outcome, "install")
  assert.ok(result.redirectUrl)
  const installUrl = new URL(result.redirectUrl)
  assert.equal(installUrl.pathname, "/apps/acme-cloud-coding/installations/new")
  assert.ok(installUrl.searchParams.get("state"))
  assert.notEqual(installUrl.searchParams.get("state"), initialState)
  github.addInstallation({ ...installation, id: 53, repositoryIds: [13] })
  github.addUser({ id: 3, name: "Leo Martin", login: "leo-martin", installationIds: [51, 52, 53] })
  assert.equal(outcome(await callback(other, choose, 3)).outcome, "choose")
  github.state.installations.delete(53)
  assert.equal(field(expectStatus(await callback(other, secondStart, 3, 51), 409).body, "error"), "installation_in_use")
  const complete = expectStatus(await other("POST", `${root}/github/install/complete`, { installationId: 51 }), 409)
  assert.equal(field(complete.body, "error"), "installation_in_use")
  assert.deepEqual(field(expectStatus(await other("GET", `${root}/github/installations`), 200).body, "installations"), [{ installationId: 52, accountLogin: "acme", accountType: "Organization" }])
})

test("GitHub callback requires the same signed-in account and active organization", async () => {
  const state = stateFrom(await member("POST", `${root}/github/link/start`))
  const call = den.as(arjun, first.orgId)
  const code = github.issueCode(4)
  const before = github.state.codeExchanges
  const mismatch = expectStatus(await call("POST", callbackPath, { state, code }), 409)
  assert.equal(field(mismatch.body, "error"), "different_account")
  assert.equal(mismatch.headers.get("cache-control"), "no-store")
  assert.equal(await rawLink(sam.memberId), undefined)
  assert.equal(await rawLink(arjun.memberId), undefined)
  const leoStart = await den.as(leo, first.orgId)("POST", `${root}/github/link/start`)
  const crossOrg = expectStatus(await other("POST", callbackPath, { state: stateFrom(leoStart), code }), 409)
  assert.equal(field(crossOrg.body, "error"), "different_account")
  expectStatus(await den.request(null, "POST", callbackPath, { body: { state, code } }), 401)
  assert.equal(github.state.codeExchanges, before)
})

test("GitHub callback rejects invalid and replayed state and does not link on a failed exchange", async () => {
  const state = stateFrom(await member("POST", `${root}/github/link/start`))
  const expired = createCloudCodingState({ ...scope(sam), userId: normalizeDenTypeId("user", sam.userId), kind: "link" }, Date.now() - 601_000)
  const tampered = `${state.startsWith("a") ? "b" : "a"}${state.slice(1)}`
  const before = github.state.codeExchanges
  for (const invalid of [expired, tampered]) {
    const result = expectStatus(await member("POST", callbackPath, { state: invalid, code: github.issueCode(2) }), 400)
    assert.equal(field(result.body, "error"), "state_invalid")
  }
  assert.equal(github.state.codeExchanges, before)
  const failed = expectStatus(await member("POST", callbackPath, { state, code: "invalid-code" }), 502)
  assert.equal(field(failed.body, "error"), "github_error")
  const replay = expectStatus(await member("POST", callbackPath, { state, code: github.issueCode(2) }), 400)
  assert.equal(field(replay.body, "error"), "state_invalid")
  assert.equal(github.state.codeExchanges, before + 1)
  assert.equal(await rawLink(sam.memberId), undefined)
})

test("access settings control people, teams, and readiness in order", async () => {
  const settings = (body: object) => manage("PUT", `${root}/settings`, body)
  assert.equal((await getCloudCodingReadiness(scope(sam))).readiness, "account_not_linked")
  assert.equal(view(await settings({ enabled: false })).people.every(person => !person.canUse), true)
  assert.equal((await getCloudCodingReadiness(scope(sam))).readiness, "turned_off")
  assert.equal(field(expectStatus(await member("POST", `${root}/github/link/start`), 409).body, "error"), "turned_off")
  const chosen = view(await settings({ enabled: true, access: { orgWide: false, memberIds: [sam.memberId], teamIds: [] } }))
  assert.deepEqual(chosen.people.filter(person => person.canUse).map(person => person.memberId), [sam.memberId])
  assert.equal((await getCloudCodingReadiness(scope(leo))).readiness, "not_allowed")
  const team = await den.createTeam(owner, first.orgId, "Acme Corp", [leo.memberId])
  const teamAccess = view(await settings({ access: { orgWide: false, memberIds: [], teamIds: [team] } }))
  assert.deepEqual(teamAccess.people.filter(person => person.canUse).map(person => person.memberId), [leo.memberId])
  expectStatus(await settings({ access: { orgWide: false, memberIds: [second.owner.memberId], teamIds: [] } }), 400)
  assert.equal(view(await settings({ access: { orgWide: true, memberIds: [], teamIds: [] } })).people.every(person => person.canUse), true)
})

test("linking encrypts credentials, rejects duplicate accounts, and serializes refresh", async t => {
  const logs: string[] = []
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream)
    t.mock.method(stream, "write", (chunk: string | Uint8Array, encoding?: BufferEncoding, callback?: (error?: Error | null) => void) => {
      logs.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
      return write(chunk, encoding, callback)
    })
  }
  const start = () => member("POST", `${root}/github/link/start`)
  assert.equal(field(expectStatus(await callback(member, await start(), 1), 409).body, "error"), "account_in_use")
  assert.equal(outcome(await callback(member, await start(), 2)).outcome, "linked")
  const raw = await rawLink(sam.memberId)
  assert.ok(raw?.access_token.startsWith("enc:v1:"))
  assert.ok(raw?.refresh_token.startsWith("enc:v1:"))
  const [credentials] = [...github.state.userTokens.values()].filter(row => row.userId === 2)
  assert.ok(credentials)
  const audit = await den.auditStorageText()
  const response = await member("GET", root)
  for (const secret of [credentials.accessToken, credentials.refreshToken]) {
    assert.equal(response.text.includes(secret), false)
    assert.equal(audit.includes(secret), false)
  }
  assert.match(audit, /cloud_coding\.account\.linked/)
  if (!("getConnection" in client)) throw new Error("Expected MySQL.")
  const expire = () => client.query("UPDATE cloud_coding_github_link SET access_token_expires_at = NOW(3) WHERE org_membership_id = ?", [sam.memberId])
  await expire()
  const [a, b] = await Promise.all([getMemberGithubAccessToken(scope(sam)), getMemberGithubAccessToken(scope(sam))])
  assert.ok(a)
  assert.equal(a, b)
  assert.notEqual(a, credentials.accessToken)
  assert.equal(github.state.refreshes, 1)
  github.state.rejectRefresh = true
  await expire()
  assert.equal(await getMemberGithubAccessToken(scope(sam)), null)
  assert.equal(await rawLink(sam.memberId), undefined)
  github.state.rejectRefresh = false
  const capturedLogs = logs.join("\n")
  for (const secret of [credentials.accessToken, credentials.refreshToken, a]) {
    assert.equal(capturedLogs.includes(secret), false, "logs do not contain a GitHub token")
  }
})

test("the outbox receives each kind of Cloud coding email", async () => {
  expectStatus(await manage("POST", `${root}/people/${sam.memberId}/send-link`), 200)
  expectStatus(await member("POST", `${root}/admin-requests`), 200)
  const outbox = await den.request(null, "GET", "/v1/dev/emails")
  expectStatus(outbox, 200)
  const data = z.object({ items: z.array(z.object({ template: z.string(), to: z.string() })).optional(), emails: z.array(z.object({ template: z.string(), to: z.string() })).optional() }).parse(outbox.body)
  const rows = data.emails ?? data.items ?? []
  assert.deepEqual(rows.filter(row => row.template === "cloudCodingLinkGithub").map(row => row.to), [sam.email])
  assert.deepEqual(rows.filter(row => row.template === "cloudCodingAdminRequest").map(row => row.to).sort(), [owner.email, leo.email].sort())
})

test("unlink, admin removal, and self-leave revoke credentials", async () => {
  for (const [person, id, remove] of [
    [sam, 2, () => member("DELETE", `${root}/github/link`)],
    [arjun, 4, () => manage("DELETE", `/v1/members/${arjun.memberId}`)],
    [leo, 3, () => den.as(leo, first.orgId)("POST", "/api/auth/organization/leave", { organizationId: first.orgId })],
  ] as const) {
    const call = den.as(person, first.orgId)
    assert.equal(outcome(await callback(call, await call("POST", `${root}/github/link/start`), id)).outcome, "linked")
    const token = await getMemberGithubAccessToken(scope(person))
    assert.ok(token)
    expectStatus(await remove(), person === leo ? 200 : 204)
    assert.equal(await rawLink(person.memberId), undefined)
    assert.equal(github.state.revoked.includes(token), true)
  }
})

test("signed events update repositories and pulls without crossing organizations", async () => {
  expectStatus(await hook("installation", { action: "deleted", installation: { id: 51 } }, false), 401)
  installation.repositoryIds = [11, 13]
  expectStatus(await hook("installation_repositories", { action: "removed", installation: { id: 51 } }), 200)
  assert.deepEqual(view(await manage("GET", root)).repositories.map(repo => repo.fullName), ["acme/docs", "acme/storefront"])
  const ownerScope = scope(first.owner)
  await db.insert(CloudCodingPullRequestTable).values({
    id: createDenTypeId("cloudCodingPullRequest"), organizationId, openedByOrgMembershipId: ownerScope.memberId, openedByName: owner.name, approvalId: createDenTypeId("cloudCodingPushApproval"), taskId: createDenTypeId("cloudCodingTask"), githubRepositoryId: 11, repositoryFullName: "acme/storefront", number: 1, title: "Update storefront", url: `${github.url}/acme/storefront/pull/1`, branch: "update-storefront", headSha: "a".repeat(40),
  })
  expectStatus(await hook("pull_request", { action: "closed", installation: { id: 51 }, repository: { id: 11 }, pull_request: { number: 1, title: "Update storefront", merged: true } }), 200)
  assert.equal(view(await manage("GET", root)).pullRequests[0]?.state, "merged")
  const isolated = view(await other("GET", root))
  assert.equal(isolated.connection, null)
  assert.deepEqual(isolated.pullRequests, [])
  assert.deepEqual(isolated.people.map(person => person.memberId), [second.owner.memberId])
  expectStatus(await hook("github_app_authorization", { action: "revoked", sender: { id: 1 } }), 200)
  assert.equal(await rawLink(first.owner.memberId), undefined)
  expectStatus(await hook("installation", { action: "deleted", installation: { id: 51 } }), 200)
  const disconnected = view(await manage("GET", root))
  assert.equal(disconnected.connection, null)
  assert.deepEqual(disconnected.repositories, [])
  assert.equal(disconnected.pullRequests.length, 1)
})
