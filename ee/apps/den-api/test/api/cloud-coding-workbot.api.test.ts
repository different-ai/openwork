import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AuditEventTable, CloudCodingPushApprovalTable, CloudCodingTaskTable, MemberTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { cloudCodingPushApprovalListSchema, cloudCodingPushApprovalSchema } from "@openwork/types/den/cloud-coding"
import { bootDen, field, summary, text, type Call, type Method, type Session } from "./harness.js"
import { startFakeGithubGit } from "./cloud-coding-fake-github-git.js"

const github = await startFakeGithubGit()
after(() => github.close())
const origin = "http://localhost:4200"
const den = await bootDen({ env: { ...github.env, DEN_WORKBOT_URL: origin, DEN_DEPLOYMENT: "cloud", DEN_AUDIT_CAPTURE_ENABLED: "true", DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(() => den.close())
const { auth, DEN_MCP_OAUTH_RESOURCE } = await import("../../src/auth.js")
const { db } = await import("../../src/db.js")
const { findCloudCodingRepository } = await import("../../src/cloud-coding/installation.js")
const { mintHeadlessRunMcpToken } = await import("../../src/mcp/headless-run-token-mint.js")
const { WORKBOT_OAUTH_CLIENT_ID } = await import("../../src/workbot/config.js")
const { buildOrganizationApiKeyMetadata } = await import("../../src/api-keys.js")

const maya = await den.createOrg(await den.signUp("Maya Chen"), "Acme Corp")
const sam = await den.newMember(maya.owner, maya.orgId, "Sam Rivera")
const organizationId = normalizeDenTypeId("organization", maya.orgId)
const memberId = normalizeDenTypeId("member", maya.owner.memberId)
const userId = normalizeDenTypeId("user", maya.owner.userId)
const web = den.as(maya.owner, maya.orgId)
const root = "/v1/workbot/cloud-coding/approvals"
const webRoot = "/v1/cloud-coding/approvals"
const fullName = "acme/storefront"
const base = await github.seedRepository(fullName, { "README.md": "Original\n" })
github.addRepository({ id: 11, full_name: fullName, default_branch: "main", private: true, archived: false })
github.addInstallation({ id: 51, account: { id: 71, login: "acme", type: "Organization" }, repository_selection: "selected", suspended_at: null, html_url: `${github.url}/settings/installations/51`, repositoryIds: [11] })
github.addUser({ id: 1, login: "maya-chen", name: "Maya Chen", installationIds: [51], writableRepositoryIds: [11] })
github.addUser({ id: 2, login: "sam-rivera", name: "Sam Rivera", installationIds: [51], writableRepositoryIds: [11] })

function status(result: Call, expected: number) {
  assert.equal(result.status, expected, summary(result))
  return result.body
}
async function connect(call: typeof web, githubId: number, installationId?: number) {
  const path = installationId ? "install/start" : "link/start"
  const result = await call("POST", `/v1/cloud-coding/github/${path}`, installationId ? {} : undefined)
  const url = new URL(text(field(status(result, 200), "redirectUrl"), "GitHub redirect"))
  status(await call("POST", "/v1/cloud-coding/github/callback", { state: url.searchParams.get("state"), code: github.issueCode(githubId), installationId }), 200)
}
status(await den.setFeature(maya.orgId, "cloudCoding", true), 200)
await connect(web, 1, 51)
await connect(den.as(sam, maya.orgId), 2)
const repository = await findCloudCodingRepository({ organizationId, fullName })
assert.ok(repository)
const repositoryId = repository.id

async function issueApproval(person: Session & { memberId: string }, state: "pending" | "denied" = "pending") {
  const taskId = createDenTypeId("cloudCodingTask")
  const id = createDenTypeId("cloudCodingPushApproval")
  const orgMembershipId = normalizeDenTypeId("member", person.memberId)
  const common = { organizationId, orgMembershipId, githubRepositoryId: 11, repositoryFullName: fullName, baseBranch: "main", title: "Update README" }
  await db.insert(CloudCodingTaskTable).values({ ...common, id: taskId, repositoryId, surface: "workbot", status: "awaiting_approval" })
  await db.insert(CloudCodingPushApprovalTable).values({ ...common, id, taskId, status: state, branch: "openwork/readme", baseSha: base, treeSha: "a".repeat(40), headSha: "b".repeat(40), commitTime: 1, authorName: person.name, authorEmail: person.email, commitMessage: "Update README", summary: { files: [{ path: "README.md", change: "modified" }], fileCount: 1, tests: { status: "passed", command: null, summary: null } }, expiresAt: new Date(Date.now() + 60_000) })
  return id
}

const scopes = "openid profile email mcp:read mcp:write offline_access"
async function oauth(person: Session, clientId: string, redirect: string, scope = scopes, consent = false) {
  const headers = { cookie: person.cookie }
  status(await den.request(person.token, "POST", "/api/auth/organization/set-active", { headers, body: { organizationId } }), 200)
  const verifier = randomBytes(32).toString("base64url")
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope, resource: DEN_MCP_OAUTH_RESOURCE, state: randomBytes(8).toString("hex"), code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" })
  const authorized = await den.request(person.token, "GET", `/api/auth/oauth2/authorize?${query}`, { headers })
  let location = new URL(text(authorized.headers.get("location"), summary(authorized)))
  if (consent) {
    const accepted = await den.request(person.token, "POST", "/api/auth/oauth2/consent", { headers, body: { accept: true, scope, oauth_query: location.search.slice(1) } })
    location = new URL(text(field(status(accepted, 200), "url"), "Consent redirect"))
  }
  const code = location.searchParams.get("code")
  assert.ok(code, `Authorization redirected to ${location.pathname}, error: ${location.searchParams.get("error")}`)
  const body = new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect, client_id: clientId, resource: DEN_MCP_OAUTH_RESOURCE })
  const response = await den.request(null, "POST", "/api/auth/oauth2/token", { headers: { "content-type": "application/x-www-form-urlencoded" }, rawBody: body.toString() })
  return text(field(status(response, 200), "access_token"), "Workbot access token")
}
const token = await oauth(maya.owner, WORKBOT_OAUTH_CLIENT_ID, `${origin}/auth/callback`)
const workbot = (method: Method, path: string, body?: unknown, credential = token) => den.request(credential, method, path, { body })
const decidePath = (id: string) => `${root}/${id}/decision`
const allow = { decision: "allow_once" }
const deny = { decision: "deny" }

test("lists only the caller's pending approvals and refuses another member's approval", async () => {
  const own = await issueApproval(maya.owner)
  const other = await issueApproval(sam)
  const denied = await issueApproval(maya.owner, "denied")
  const list = cloudCodingPushApprovalListSchema.parse(status(await workbot("GET", root), 200))
  assert.deepEqual(list.approvals.map(approval => approval.id), [own])
  assert.equal(cloudCodingPushApprovalSchema.parse(status(await workbot("GET", `${root}/${denied}`), 200)).status, "denied")
  status(await workbot("GET", `${root}/${other}`), 404)
  status(await workbot("POST", decidePath(other), allow), 404)
})

test("allows and denies once, audits as the member, and settles approvals in both surfaces", async () => {
  const allowed = await issueApproval(maya.owner)
  const denied = await issueApproval(maya.owner)
  const elsewhere = await issueApproval(maya.owner)
  assert.equal(cloudCodingPushApprovalSchema.parse(status(await workbot("POST", decidePath(allowed), allow), 200)).status, "approved")
  assert.equal(cloudCodingPushApprovalSchema.parse(status(await workbot("POST", decidePath(denied), deny), 200)).status, "denied")
  assert.equal(field(status(await workbot("POST", decidePath(allowed), deny), 409), "error"), "approval_not_pending")
  status(await web("POST", `${webRoot}/${allowed}/decision`, deny), 409)
  status(await web("POST", `${webRoot}/${elsewhere}/decision`, deny), 200)
  status(await workbot("POST", decidePath(elsewhere), allow), 409)
  const events = await db.$primary.select().from(AuditEventTable).where(eq(AuditEventTable.org_id, organizationId))
  for (const [action, id] of [["cloud_coding.push.approved", allowed], ["cloud_coding.push.denied", denied]]) {
    assert.ok(events.some(event => event.action === action && event.envelope?.actor?.id === userId && event.envelope?.actor?.memberId === memberId && JSON.stringify(event.envelope).includes(id ?? "")), action)
  }
})

test("returns feature disabled on all routes and leaves the row pending", async () => {
  const id = await issueApproval(maya.owner)
  status(await den.setFeature(maya.orgId, "cloudCoding", false), 200)
  try {
    for (const [method, path] of [["GET", root], ["GET", `${root}/${id}`], ["POST", decidePath(id)]] as const) {
      assert.equal(field(status(await workbot(method, path, method === "POST" ? allow : undefined), 404), "error"), "feature_disabled")
    }
  } finally {
    status(await den.setFeature(maya.orgId, "cloudCoding", true), 200)
  }
  assert.equal(cloudCodingPushApprovalSchema.parse(status(await workbot("GET", `${root}/${id}`), 200)).status, "pending")
})

test("refuses headless, desktop, third-party and API key credentials and requires write scope to decide", async () => {
  const id = await issueApproval(maya.owner)
  const headless = await mintHeadlessRunMcpToken({ userId, organizationId })
  const desktop = await den.mintMcpToken(maya.owner, organizationId)
  const redirect = "http://127.0.0.1:9/callback"
  const registered = await den.request(null, "POST", "/api/auth/oauth2/register", { body: { client_name: "Acme Corp", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: scopes } })
  const thirdParty = await oauth(maya.owner, text(field(status(registered, 201), "client_id"), "External client id"), redirect, scopes, true)
  const { key } = await auth.api.createApiKey({ body: { userId, name: "Acme Corp", metadata: buildOrganizationApiKeyMetadata({ organizationId, orgMembershipId: memberId, issuedByUserId: userId, issuedByOrgMembershipId: memberId }) } })
  for (const [name, credential] of [["headless", headless.token], ["desktop", desktop], ["third-party", thirdParty], ["API key", key]] as const) {
    for (const [method, path] of [["GET", root], ["GET", `${root}/${id}`], ["POST", decidePath(id)]] as const) {
      const response = await workbot(method, path, method === "POST" ? allow : undefined, credential)
      assert.equal(response.status, 403, `${name} ${path}: ${summary(response)}`)
    }
  }
  const readOnly = await oauth(maya.owner, WORKBOT_OAUTH_CLIENT_ID, `${origin}/auth/callback`, "openid profile email mcp:read")
  status(await workbot("GET", root, undefined, readOnly), 200)
  assert.equal(field(status(await workbot("POST", decidePath(id), allow, readOnly), 403), "error"), "insufficient_scope")
  assert.equal(cloudCodingPushApprovalSchema.parse(status(await workbot("GET", `${root}/${id}`), 200)).status, "pending")
})

test("rechecks active membership even for a previously issued Workbot token", async () => {
  const id = await issueApproval(sam)
  const memberToken = await oauth(sam, WORKBOT_OAUTH_CLIENT_ID, `${origin}/auth/callback`)
  status(await workbot("GET", `${root}/${id}`, undefined, memberToken), 200)
  await db.update(MemberTable).set({ removedAt: new Date() }).where(eq(MemberTable.id, normalizeDenTypeId("member", sam.memberId)))
  status(await workbot("GET", root, undefined, memberToken), 403)
  status(await workbot("POST", decidePath(id), allow, memberToken), 403)
  const [row] = await db.$primary.select().from(CloudCodingPushApprovalTable).where(eq(CloudCodingPushApprovalTable.id, id))
  assert.equal(row?.status, "pending")
})
