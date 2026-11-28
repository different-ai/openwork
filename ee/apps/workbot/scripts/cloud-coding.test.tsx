import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { renderToStaticMarkup } from "react-dom/server"
import type { CloudCodingPushApproval } from "@openwork/types/den/cloud-coding"
import { createCloudCodingApprovals } from "../../../packages/workbot-ui/src/cloud-coding-approvals.js"
import { CloudCodingApprovalCard } from "../../../packages/workbot-ui/src/cloud-coding-card.js"
import { createAuth, type AppEnv } from "../src/server/auth.js"
import { createDen, denSessionSchema, workbotApprovalPath } from "../src/server/den.js"
import { loadConfig } from "../src/server/config.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"

const path = workbotApprovalPath
const pending: CloudCodingPushApproval = {
  id: "approval_1", taskId: "task_1", status: "pending", repositoryFullName: "acme/storefront", branch: "openwork/readme", baseBranch: "main", title: "Update README", headSha: "a".repeat(40),
  files: [{ path: "README.md", change: "modified" }], fileCount: 1, tests: { status: "passed", command: null, summary: null },
  requestedAt: "2026-11-27T12:00:00.000Z", expiresAt: "2026-11-28T12:00:00.000Z", decidedAt: null, pullRequest: null,
}
const url = "https://github.com/acme/storefront/pull/7"
const detail = `${path}/${pending.id}`
const decisionPath = `${detail}/decision`
const approved = { ...pending, status: "approved" } as const
const denied = { ...pending, status: "denied" } as const
const pushed = { ...pending, status: "pushed", pullRequest: { number: 7, url, state: "open" } } as const
const off = { error: "feature_disabled", feature: "cloudCoding" }
const settled = { error: "approval_not_pending", message: "This push approval is no longer waiting for a decision." }
const json = (payload: unknown, status = 200) => ({ response: Response.json(payload, { status }), payload })
const noop = () => undefined

function render(entry: { approval: CloudCodingPushApproval; elsewhere?: boolean; error?: string }) {
  return renderToStaticMarkup(<CloudCodingApprovalCard entry={entry} icons={["https://cdn.simpleicons.org/github"]} onDecide={noop} onRetry={noop} onDismiss={noop} />)
}

test("the approval card names the repository, branch, tests, changed files and exactly two actions", () => {
  const one = render({ approval: pending })
  assert.match(one, /Push to acme\/storefront\?/)
  assert.match(one, /simpleicons.org\/github/)
  assert.match(one, /New branch <code class="font-mono">openwork\/readme<\/code> · 1 file changed · <span>Tests passed/)
  assert.match(one, /OpenWork will open a pull request in your name. Nothing has been sent to GitHub yet./)
  assert.match(one, /<details class="group[^>]+><summary[^>]*>.*Files changed/)
  assert.deepEqual([...one.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map(match => match[1]), ["Deny", "Allow once"])
  const many = render({ approval: { ...pending, fileCount: 5, files: [...pending.files, { path: "new.md", change: "added" }, { path: "old.md", change: "deleted" }], tests: { ...pending.tests, status: "failed" } } })
  assert.match(many, /5 files changed/)
  assert.match(many, /wb-danger[^>]*>Tests failed/)
  assert.match(many, /README\.md<\/code> · Changed.*new\.md<\/code> · Added.*old\.md<\/code> · Removed.*and 2 more/)
  assert.match(render({ approval: { ...pending, tests: { ...pending.tests, status: "not_run" } } }), /<span>Tests not run/)
})

test("allow once retains the card until the PR opens, then allows dismissal", async () => {
  let current: CloudCodingPushApproval = pending
  const store = createCloudCodingApprovals(async (request, init) => {
    if (request === decisionPath) {
      assert.equal(init?.method, "POST")
      assert.equal(init.body, JSON.stringify({ decision: "allow_once" }))
      current = approved
    }
    return json(request === path ? { approvals: current.status === "pending" ? [current] : [] } : current)
  })
  await store.refresh()
  await store.decide(pending.id, "allow_once")
  const entry = () => { const result = store.snapshot().entries[0]; assert.ok(result); return result }
  assert.match(render(entry()), /Allowed\. Pushing .*openwork\/readme.*…/)
  await store.refresh()
  assert.equal(entry().approval.status, "approved")
  current = pushed
  await store.refresh()
  const html = render(entry())
  assert.match(html, /Pull request opened · acme\/storefront #7/)
  assert.match(html, /href="https:\/\/github.com\/acme\/storefront\/pull\/7" target="_blank"[^>]*>Open pull request/)
  assert.match(html, /Dismiss push approval/)
  store.dismiss(pending.id)
  assert.deepEqual(store.snapshot().entries, [])
})

test("deny and a 409 both display Den's real outcome", async () => {
  for (const conflict of [false, true]) {
    const store = createCloudCodingApprovals(async request => request === path ? json({ approvals: [pending] }) : request === decisionPath && conflict ? json(settled, 409) : json(conflict ? approved : denied))
    await store.refresh()
    await store.decide(pending.id, "deny")
    const entry = store.snapshot().entries[0]
    assert.ok(entry)
    assert.match(render(entry), conflict ? /Allowed elsewhere\. Pushing/ : /Denied\. Nothing was pushed\./)
  }
})

test("reads an approval that disappears, keeps it on failure, and retries the detail once asked", async () => {
  let lists = 0
  let reads = 0
  const store = createCloudCodingApprovals(async request => {
    if (request === path) return json({ approvals: ++lists === 1 ? [pending] : [] })
    return ++reads === 1 ? json(null, 503) : json(denied)
  })
  await store.refresh()
  await store.refresh()
  await store.refresh()
  assert.equal(reads, 1)
  const failed = store.snapshot().entries[0]
  assert.ok(failed)
  assert.match(render(failed), /role="alert".*Retry/)
  await store.retry(pending.id)
  const entry = store.snapshot().entries[0]
  assert.ok(entry)
  assert.match(render(entry), /Denied elsewhere\. Nothing was pushed\./)
})

test("a request failure leaves the decision retryable; feature disabled stops further requests", async () => {
  let calls = 0
  let featureOff = false
  let postFailed = true
  const store = createCloudCodingApprovals(async request => {
    calls++
    if (featureOff) return json(off, 404)
    if (request === path) return json({ approvals: [pending] })
    if (postFailed) { postFailed = false; throw new Error("offline") }
    return json(denied)
  })
  await store.refresh()
  await store.decide(pending.id, "deny")
  assert.equal(store.snapshot().entries[0]?.retry, "deny")
  await store.retry(pending.id)
  assert.equal(store.snapshot().entries[0]?.approval.status, "denied")
  featureOff = true
  await store.refresh()
  const before = calls
  await store.refresh()
  assert.equal(calls, before)
  assert.deepEqual(store.snapshot(), { disabled: true, error: "", entries: [] })
})

test("BFF requires member and same origin, uses the person's token, validates bodies and passes Den conflicts through", async t => {
  const config = loadConfig({ WORKBOT_PUBLIC_URL: "https://workbot.test", WORKBOT_DEN_API_URL: "https://den.test", WORKBOT_RUNNER_URL: "http://runner", WORKBOT_RUNNER_TOKEN: "test-runner-token-test-runner-token", WORKBOT_SESSION_SECRET: "test-session-secret-test-session-secret" })
  const den = createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl })
  const app = new Hono<AppEnv>()
  const who = denSessionSchema.parse({ user: { id: "user_test", name: "Maya Chen", email: "maya@acme.test" }, organization: { id: "org_test", name: "Acme Corp", brandAppName: null }, memberId: "member_test", enabled: true, canSchedule: false })
  const calls: Array<[string, string, unknown]> = []
  let list = json({ approvals: [pending] })
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-token")
    calls.push([init.method ?? "GET", input, typeof init.body === "string" ? JSON.parse(init.body) : null])
    return input.endsWith("/decision") ? json(settled, 409).response : input.endsWith(pending.id) ? json(pending).response : list.response
  })
  registerWorkbotRoutes(app, { config, den, sameOrigin: createAuth({ config, den }).sameOrigin, member: async (c, next) => {
    if (!c.req.header("cookie")) return c.json({ error: "signed_out" }, 401)
    const accessToken = "fixture-token"
    c.set("member", { session: { id: "session_test", userId: who.user.id, organizationId: who.organization.id, tokens: { accessToken, refreshToken: null, expiresAt: Date.now() + 60_000 }, createdAt: Date.now() }, accessToken, den: who, app: false })
    await next()
  } })
  const member = { cookie: "fixture=1", origin: config.publicUrl, "content-type": "application/json" }
  const post = (headers: Record<string, string>, decision: string) => app.request(decisionPath, { method: "POST", headers, body: JSON.stringify({ decision }) })
  assert.equal((await app.request(path)).status, 401)
  assert.equal((await post({}, "allow_once")).status, 401)
  assert.equal((await post({ ...member, origin: "https://elsewhere.test" }, "allow_once")).status, 403)
  assert.equal((await post(member, "always")).status, 400)
  assert.deepEqual(calls, [])
  assert.deepEqual(await (await app.request(path, { headers: member })).json(), { approvals: [pending] })
  assert.deepEqual(await (await app.request(detail, { headers: member })).json(), pending)
  const conflict = await post(member, "allow_once")
  assert.equal(conflict.status, 409)
  assert.deepEqual(await conflict.json(), settled)
  assert.deepEqual(calls[2], ["POST", `${config.denApiUrl}${decisionPath}`, { decision: "allow_once" }])
  list = json(off, 404)
  const disabled = await app.request(path, { headers: member })
  assert.equal(disabled.status, 404)
  assert.deepEqual(await disabled.json(), off)
  list = json({ approvals: [{}] })
  assert.equal((await app.request(path, { headers: member })).status, 502)
})
