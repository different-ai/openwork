/**
 * Sandbox Slack (sandboxSlack): a sandbox gets the sample work apps' Slack with the Workbot Slack app installed, so
 * Workbot's settings see the Slack app (Proactive Mode can be turned on) and a member's agent messages arrive on
 * that member's own sample Slack page. Every other organization keeps Slack's API, a sample token is never sent to
 * Slack, and a real Slack app can't be installed on the sample connector.
 *
 * Runs the real workshop gateway (evals/packages/open-workplace/src/workshop.mjs) in its no-password mode: each
 * "browser" below is a cookie jar, the same isolation people get from separate browser profiles.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"
import { bootDen, field, list, summary, text, type Session } from "./harness.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud" } })
after(() => den.close())
const { client } = await import("../../src/db.js")
const { readWorkbotDirectMessages, resolveWorkbotDirectMessageTarget, sendWorkbotDirectMessage, workbotSlackAppReady } = await import("../../src/slack-assistant/direct-message.js")
const { isSandboxSlackToken, SlackApiError, slackClient } = await import("../../src/slack-assistant/protocol.js")

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address === "string") throw new Error("no port")
  return address.port
}

const workplace = `http://127.0.0.1:${await freePort()}`
let child: ReturnType<typeof spawn> | null = null
after(() => { child?.kill("SIGTERM") })
before(async () => {
  child = spawn(process.execPath, [fileURLToPath(new URL("../../../../../evals/packages/open-workplace/src/workshop.mjs", import.meta.url))], {
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: new URL(workplace).port, PUBLIC_URL: workplace, OPEN_WORKPLACE_JOIN_MODE: "automatic", OPEN_WORKPLACE_PARTICIPANTS: "[]" },
    stdio: "ignore",
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    const health: unknown = await fetch(`${workplace}/health`).then((response) => response.json()).catch(() => null)
    if (field(health, "slack") === true) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error("The sample work apps did not start")
})

const admin = await den.signUp("Platform Admin", `platform-admin+${den.stamp}@example.test`)
const rollout = (body: { enabled?: boolean; killed?: boolean }) => den.request(admin.token, "PUT", "/v1/admin/features/sandboxSlack", { body })
const create = (name: string) => den.request(admin.token, "POST", "/v1/admin/sandbox-orgs", {
  body: { name, connectorBaseUrl: workplace, days: 14, memberLimit: 5, allowedEmailDomains: [], joinRole: "member" },
})
const join = async (sandbox: unknown, name: string) => {
  const person = await den.signUp(name)
  const token = text(new URL(text(field(sandbox, "joinLink"), "join link")).searchParams.get("token"), "join token")
  const joined = await den.request(person.token, "POST", "/v1/sandbox-join", { body: { token } })
  assert.equal(joined.status, 200, summary(joined))
  return person
}
const connections = async (orgId: string) => list(field((await den.as(admin, orgId)("GET", "/v1/mcp-connections")).body, "connections"))

/** A browser profile: its own cookie, so its own private sample workspace and its own sample Slack page. */
async function browser() {
  const entered = await fetch(`${workplace}/login?next=%2F`, { redirect: "manual", headers: { accept: "text/html" } })
  const cookie = entered.headers.get("set-cookie")?.split(";")[0] ?? ""
  assert.ok(cookie, "the workshop gives the browser its own workspace")
  return {
    cookie,
    async slackPage() { return (await fetch(`${workplace}/slack`, { headers: { cookie, accept: "text/html" } })).text() },
    async reply(message: string) {
      const team = (await this.slackPage()).match(/name="team" value="([^"]+)"/)?.[1] ?? ""
      const response = await fetch(`${workplace}/slack/messages`, { method: "POST", redirect: "manual", headers: { cookie, origin: workplace, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ team, text: message }) })
      assert.equal(response.status, 303, await response.text())
    },
  }
}
type Browser = Awaited<ReturnType<typeof browser>>

/** The member presses Connect on the Slack connector, approves on the workshop's consent page, and Den finishes the sign-in. */
async function connect(person: Session, orgId: string, connectionId: string, profile: Browser) {
  const started = await den.as(person, orgId)("GET", `/v1/mcp-connections/${connectionId}/connect/start`)
  assert.equal(started.status, 200, summary(started))
  const authorizeUrl = new URL(text(field(started.body, "authorizeUrl"), "authorize url"))
  assert.equal(authorizeUrl.origin, workplace, "the sample connector signs in at the sandbox's work apps, not Slack")
  const consent = await fetch(authorizeUrl, { redirect: "manual", headers: { cookie: profile.cookie, accept: "text/html" } })
  assert.equal(consent.status, 200)
  const html = await consent.text()
  assert.match(html, /Read your sample Slack messages\./)
  const fields = new URLSearchParams([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((match) => [match[1] ?? "", (match[2] ?? "").replaceAll("&amp;", "&")]))
  fields.set("decision", "allow")
  const allowed = await fetch(`${workplace}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { cookie: profile.cookie, origin: workplace, "content-type": "application/x-www-form-urlencoded" }, body: fields })
  assert.equal(allowed.status, 303, await allowed.text())
  const callback = new URL(allowed.headers.get("location") ?? "")
  const finished = await den.request(null, "GET", `${callback.pathname}${callback.search}`)
  assert.equal(finished.status, 200, finished.text.slice(0, 300))
}

test("off by default: a sandbox gets no sample Slack, and Workbot has no Slack app", async () => {
  const created = await create("Before the rollout")
  assert.equal(created.status, 200, summary(created))
  const sandbox = field(created.body, "sandbox")
  assert.equal(field(sandbox, "sampleSlack"), false)
  assert.equal(field(sandbox, "connectorCount"), 5)
  assert.equal(await workbotSlackAppReady(text(field(sandbox, "organizationId"), "organization id")), false)
})

test("on: Workbot's Slack app is installed, and a member's agent messages arrive on their own sample Slack page", async () => {
  assert.equal((await rollout({ enabled: true })).status, 200)
  const created = await create("Demo sandbox")
  assert.equal(created.status, 200, summary(created))
  const sandbox = field(created.body, "sandbox")
  const orgId = text(field(sandbox, "organizationId"), "organization id")
  assert.equal(field(sandbox, "sampleSlack"), true)
  assert.equal(field(sandbox, "connectorCount"), 6)
  const slack = (await connections(orgId)).find((entry) => entry.name === "Slack")
  assert.equal(slack?.url, `${workplace}/slack/mcp`)
  const connectionId = text(slack?.id, "connection id")
  assert.equal(await workbotSlackAppReady(orgId), true, "Proactive Mode's \"Needs the Slack app first\" lock is cleared")

  // A real Slack app can't be set up on the sample connector: the setup routes still want Slack's own connector.
  const assistant = await den.as(admin, orgId)("GET", `/v1/mcp-connections/${connectionId}/slack-assistant`)
  assert.equal(assistant.status, 200, summary(assistant))
  assert.deepEqual([field(assistant.body, "installed"), field(assistant.body, "eligible")], [true, false])

  const avery = await join(sandbox, "Avery Demo"), riley = await join(sandbox, "Riley Demo")
  const averyBrowser = await browser(), rileyBrowser = await browser()
  assert.deepEqual(await resolveWorkbotDirectMessageTarget({ organizationId: orgId, userId: avery.userId }), { ok: false, reason: "member_not_linked" }, "nobody is messaged before they connect Slack")

  await connect(avery, orgId, connectionId, averyBrowser)
  const target = await resolveWorkbotDirectMessageTarget({ organizationId: orgId, userId: avery.userId })
  assert.equal(target.ok, true, "connecting Slack links the member to their sample Slack user")

  const sent = await sendWorkbotDirectMessage({ organizationId: orgId, userId: avery.userId, text: "*Morning brief*\nPilot review at 10:00." })
  assert.equal(sent.ok, true, JSON.stringify(sent))
  assert.match(await averyBrowser.slackPage(), /<strong>Morning brief<\/strong><br>Pilot review at 10:00\./, "the message is on Avery's sample Slack page")
  assert.doesNotMatch(await rileyBrowser.slackPage(), /Morning brief/, "and on nobody else's")
  assert.deepEqual(await resolveWorkbotDirectMessageTarget({ organizationId: orgId, userId: riley.userId }), { ok: false, reason: "member_not_linked" })

  // What the member answers on that page is what Den reads back as their side of the conversation.
  await averyBrowser.reply("I'll handle it after lunch")
  const turns = await readWorkbotDirectMessages({ organizationId: orgId, userId: avery.userId, since: Date.now() - 60_000 })
  assert.deepEqual(turns?.map((turn) => [turn.from, turn.text]), [["agent", "*Morning brief*\nPilot review at 10:00."], ["member", "I'll handle it after lunch"]])

  await connect(riley, orgId, connectionId, rileyBrowser)
  assert.equal((await sendWorkbotDirectMessage({ organizationId: orgId, userId: riley.userId, text: "For Riley only" })).ok, true)
  assert.match(await rileyBrowser.slackPage(), /For Riley only/)
  assert.doesNotMatch(await averyBrowser.slackPage(), /For Riley only/)

  // The kill switch stops the sample Slack; nothing is sent to Slack instead.
  assert.equal((await rollout({ killed: true })).status, 200)
  assert.deepEqual(await sendWorkbotDirectMessage({ organizationId: orgId, userId: avery.userId, text: "While it is off" }), { ok: false, reason: "slack_error", code: "sandbox_slack_unavailable" })
  assert.doesNotMatch(await averyBrowser.slackPage(), /While it is off/)
  assert.equal((await rollout({ killed: false, enabled: true })).status, 200)
  assert.equal((await sendWorkbotDirectMessage({ organizationId: orgId, userId: avery.userId, text: "Back on" })).ok, true, "restoring the rollout brings it back without reconnecting")

  // When the sandbox ends, so does its sample Slack.
  await client.execute("UPDATE sandbox_organization SET expires_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 MINUTE) WHERE organization_id = ?", [orgId])
  assert.deepEqual(await sendWorkbotDirectMessage({ organizationId: orgId, userId: avery.userId, text: "After it ended" }), { ok: false, reason: "slack_error", code: "sandbox_slack_unavailable" })
})

test("an existing sandbox gets it from /admin", async () => {
  assert.equal((await rollout({ enabled: false })).status, 200)
  const older = field((await create("Older sandbox")).body, "sandbox")
  const id = text(field(older, "id"), "sandbox id"), orgId = text(field(older, "organizationId"), "organization id")
  assert.equal(field(older, "sampleSlack"), false)
  const refused = await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/slack`)
  assert.equal(refused.status, 400, "needs the feature on for the organization first")
  const override = await den.request(admin.token, "PUT", `/v1/admin/organizations/${encodeURIComponent(orgId)}/capabilities`, { body: { capabilities: { sandboxSlack: true } } })
  assert.ok(override.status < 300, summary(override))
  const added = await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/slack`)
  assert.equal(added.status, 200, summary(added))
  assert.equal(field(added.body, "sandbox", "sampleSlack"), true)
  assert.equal(field(added.body, "sandbox", "connectorCount"), 6)
  assert.equal(field((await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/slack`)).body, "sandbox", "connectorCount"), 6, "adding twice is harmless")
  assert.equal(await workbotSlackAppReady(orgId), true)
})

test("a sample bot token is never sent to Slack", async () => {
  let called = 0
  const request: typeof fetch = async () => { called++; return new Response("{}") }
  assert.equal(isSandboxSlackToken("xoxb-open-workplace-abc"), true)
  assert.equal(isSandboxSlackToken("xoxb-1234-5678-real"), false)
  await assert.rejects(slackClient("xoxb-open-workplace-abc", request)("auth.test", {}), (error) => error instanceof SlackApiError && error.code === "sandbox_slack_unavailable")
  assert.equal(called, 0)
})
