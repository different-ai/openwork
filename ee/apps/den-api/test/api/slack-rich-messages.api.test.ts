/**
 * Slack components (slackRichMessages), through real Den and the real sample Slack of a sandbox organization
 * (evals/packages/open-workplace/src/workshop.mjs), which checks blocks against Slack's documented limits.
 *
 *   agent ─ MCP execute_capability slack_send_as_bot ─▶ Den ─ chat.postMessage (blocks) ─▶ sample Slack page
 *   member presses a choice ─ signed interaction ─▶ Den ─▶ queued as their next request, buttons replaced
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHmac } from "node:crypto"
import { createServer } from "node:net"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"
import { bootDen, field, isRecord, list, summary, text, type Session } from "./harness.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud", DEN_HEADLESS_RUNNER_URL: "http://127.0.0.1:9", DEN_HEADLESS_RUNNER_TOKEN: "synthetic-runner-token-for-slack-rich-messages" } })
after(() => den.close())
const { db } = await import("../../src/db.js")
const { and, eq } = await import("@openwork-ee/den-db/drizzle")
const { MemberTable, SlackAssistantEventTable, SlackAssistantIdentityTable } = await import("@openwork-ee/den-db/schema")
const { normalizeDenTypeId } = await import("@openwork-ee/utils/typeid")
const { getInstallation } = await import("../../src/slack-assistant/repository.js")
const { slackClient } = await import("../../src/slack-assistant/protocol.js")
const { processSlackEvent } = await import("../../src/slack-assistant/worker.js")

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

async function browser() {
  const entered = await fetch(`${workplace}/login?next=%2F`, { redirect: "manual", headers: { accept: "text/html" } })
  const cookie = entered.headers.get("set-cookie")?.split(";")[0] ?? ""
  assert.ok(cookie, "the workshop gives the browser its own workspace")
  return { cookie, slackPage: async () => (await fetch(`${workplace}/slack`, { headers: { cookie, accept: "text/html" } })).text() }
}
type Browser = Awaited<ReturnType<typeof browser>>

async function connect(person: Session, orgId: string, connectionId: string, profile: Browser) {
  const started = await den.as(person, orgId)("GET", `/v1/mcp-connections/${connectionId}/connect/start`)
  assert.equal(started.status, 200, summary(started))
  const consent = await fetch(text(field(started.body, "authorizeUrl"), "authorize url"), { redirect: "manual", headers: { cookie: profile.cookie, accept: "text/html" } })
  const html = await consent.text()
  const fields = new URLSearchParams([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((match) => [match[1] ?? "", (match[2] ?? "").replaceAll("&amp;", "&")]))
  fields.set("decision", "allow")
  const allowed = await fetch(`${workplace}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { cookie: profile.cookie, origin: workplace, "content-type": "application/x-www-form-urlencoded" }, body: fields })
  assert.equal(allowed.status, 303, await allowed.text())
  const callback = new URL(allowed.headers.get("location") ?? "")
  const finished = await den.as(person, orgId)("GET", `${callback.pathname}${callback.search}`)
  assert.equal(finished.status, 200, finished.text.slice(0, 300))
  assert.doesNotMatch(finished.text, /Confirm this connection/, "the person who started the connection is not asked again")
}

const created = await den.asPlatformAdmin("POST", "/v1/admin/sandbox-orgs", { name: "Acme Robotics", connectorBaseUrl: workplace, days: 2, memberLimit: 5, allowedEmailDomains: [], joinRole: "member" })
assert.equal(created.status, 200, summary(created))
const sandbox = field(created.body, "sandbox")
const orgId = text(field(sandbox, "organizationId"), "organization id")
assert.equal(field(sandbox, "sampleSlack"), true)

async function join(name: string) {
  const person = await den.signUp(name)
  const token = text(new URL(text(field(sandbox, "joinLink"), "join link")).searchParams.get("token"), "join token")
  const joined = await den.request(person.token, "POST", "/v1/sandbox-join", { body: { token } })
  assert.equal(joined.status, 200, summary(joined))
  return person
}

const avery = await join("Avery Demo"), riley = await join("Riley Demo")
const averyBrowser = await browser(), rileyBrowser = await browser()
const connectionId = text(list(field((await den.as(avery, orgId)("GET", "/v1/mcp-connections?scope=usable")).body, "connections")).find((entry) => entry.name === "Slack")?.id, "Slack connection id")
await connect(avery, orgId, connectionId, averyBrowser)
await connect(riley, orgId, connectionId, rileyBrowser)
const averyAgent = await den.mintMcpToken(avery, orgId)
const send = (body: Record<string, unknown>) => den.callMcpTool(averyAgent, "execute_capability", { name: "slack_send_as_bot", body })
const offered = async () => {
  const found = await den.callMcpTool(averyAgent, "search_capabilities", { query: "slack_send_as_bot", limit: 5 })
  const match = list(field(found.body, "matches")).find((entry) => entry.name === "slack_send_as_bot")
  const properties = field(match, "argumentsSchema", "properties")
  return isRecord(properties) ? Object.keys(properties).sort() : []
}

const REPORT = {
  target: "me",
  text: "Open issues this week: 2 open.",
  components: [
    { type: "header", text: "Open issues" },
    { type: "table", columns: ["Issue", "Owner", "Days open"], rows: [["[ACME-214](https://linear.app/acme/issue/ACME-214)", "Dana", "9"], ["ACME-221", "Lee", "6"]] },
    { type: "context", text: "From Linear <!channel> <@U0SOMEONE>" },
    { type: "buttons", buttons: [{ text: "Open in OpenWork", open: "automations" }] },
  ],
}

test("with the feature off the agent is offered text only and components are refused", async () => {
  assert.deepEqual(await offered(), ["channelId", "target", "text", "threadTs"])
  const refused = await send(REPORT)
  assert.equal(field(refused.body, "error"), "invalid_capability_arguments", refused.raw)
  const plain = await send({ target: "me", text: "Plain note" })
  assert.equal(field(plain.body, "sent"), true, plain.raw)
  const page = await averyBrowser.slackPage()
  assert.match(page, /Plain note/)
  assert.doesNotMatch(page, /<div class="bk-table">/)
})

test("with the feature on the same call arrives as a header, a real table, a context line and a button", async () => {
  assert.equal((await den.setFeature(orgId, "slackRichMessages", true)).status, 200)
  assert.deepEqual(await offered(), ["channelId", "components", "target", "text", "threadTs"])
  const sent = await send(REPORT)
  assert.equal(field(sent.body, "sent"), true, sent.raw)
  const page = await averyBrowser.slackPage()
  assert.match(page, /<div class="bk-header">Open issues<\/div>/)
  assert.match(page, /<a href="https:\/\/linear\.app\/acme\/issue\/ACME-214" target="_blank" rel="noreferrer noopener">ACME-214<\/a>/)
  assert.match(page, /<th style="text-align:right;white-space:nowrap">Days open<\/th>/)
  assert.match(page, /<a class="bk-button" href="http:\/\/localhost:3005\/dashboard\/automations"[^>]*>Open in OpenWork<\/a>/)
  assert.doesNotMatch(page, /class="mention"/, "nobody is mentioned by text a model wrote in a component")
  assert.doesNotMatch(await rileyBrowser.slackPage(), /Open issues/, "the DM is the caller's alone")

  const raw = await send({ target: "me", text: "Raw", components: [{ type: "section", text: { type: "mrkdwn", text: "<!channel>" } }] })
  assert.equal(field(raw.body, "error"), "invalid_capability_arguments", raw.raw)
  const twice = await send(REPORT)
  assert.equal(field(twice.body, "error"), "duplicate_message", twice.raw)
})

async function installed() {
  const installation = await getInstallation(normalizeDenTypeId("externalMcpConnection", connectionId))
  assert.ok(installation?.botToken && installation.teamId && installation.appId)
  return { ...installation, botToken: installation.botToken, teamId: installation.teamId, appId: installation.appId }
}

function signed(secret: string, payload: Record<string, unknown>, at = Math.floor(Date.now() / 1000)) {
  const rawBody = new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${at}:${rawBody}`).digest("hex")}`
  return { rawBody, headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": String(at), "x-slack-signature": signature } }
}

const events = () => db.select().from(SlackAssistantEventTable).where(eq(SlackAssistantEventTable.connectionId, normalizeDenTypeId("externalMcpConnection", connectionId)))

/** What the worker does on its next tick: settle every press that is waiting, and nothing else. */
async function settlePresses() {
  const waiting = (await events()).filter((event) => event.status === "pending" && JSON.parse(event.payload).type === "choice_pressed")
  for (const event of waiting) {
    const leaseOwner = `test-${event.id.slice(0, 8)}`
    await db.update(SlackAssistantEventTable).set({ leaseOwner, leaseUntil: new Date(Date.now() + 60_000) }).where(eq(SlackAssistantEventTable.id, event.id))
    await processSlackEvent({ ...event, leaseOwner })
  }
  return waiting.length
}
const requests = async () => (await events()).filter((event) => ["message", "app_mention"].includes(JSON.parse(event.payload).type))
const BUTTON = /<button type="button" class="bk-button"[^>]*>Send it<\/button>/

async function ask(lead: string) {
  const asked = await send({ target: "me", text: lead, components: [{ type: "choices", prompt: "Send it from your Gmail?", options: ["Send it", "Don't send"] }] })
  assert.equal(field(asked.body, "sent"), true, asked.raw)
  const installation = await installed()
  const bot = slackClient(installation.botToken, fetch, `${workplace}/slack/teams/${installation.teamId}/api`)
  const channel = text(field(asked.body, "channelId"), "channel")
  const history = list(field(await bot("conversations.history", { channel, oldest: "0" }), "messages"))
  const question = history.find((message) => JSON.stringify(message.blocks ?? []).includes("openwork_choice:"))
  const blockId = text(list(question?.blocks).find((block) => block.type === "actions")?.block_id, "choice block id")
  let presses = 0
  const press = (user: string, value: string, index = 0, extra: Record<string, unknown> = {}) => ({
    type: "block_actions", team: { id: installation.teamId }, user: { id: user }, api_app_id: installation.appId, channel: { id: channel },
    message: { ts: question?.ts, blocks: question?.blocks }, actions: [{ action_id: `openwork_choice:${index}`, block_id: blockId, value, action_ts: `${Date.now()}.${++presses}` }], ...extra,
  })
  const post = (payload: Record<string, unknown>, secret = installation.signingSecret) => den.request(null, "POST", `/v1/integrations/slack/${connectionId}/interactions`, signed(secret, payload))
  return { channel, ts: text(question?.ts, "question ts"), averySlackId: blockId.slice("openwork_choice:".length), press, post }
}

test("a choice is acknowledged at once, then answered only by the member it was for, and the first answer wins", async () => {
  const { channel, ts, averySlackId, press, post } = await ask("The reply to Dana is drafted.")
  assert.match(await averyBrowser.slackPage(), BUTTON)
  const rileySlackId = await slackUserOf(riley)
  const before = (await requests()).length

  assert.equal((await post(press(averySlackId, "Send it"), "not-the-signing-secret")).status, 401)
  assert.equal((await post(press(averySlackId, "Send it", 0, { team: { id: "T0OTHER" } }))).status, 403)
  assert.equal((await post(press(rileySlackId, "Send it"))).status, 200)
  assert.equal((await post(press(averySlackId, "Delete everything"))).status, 200)
  const link = await post({ ...press(averySlackId, "Send it"), actions: [{ action_id: "openwork_link:0", block_id: "openwork_link:1" }] })
  assert.equal(link.status, 200, "a link button's interaction is acknowledged")
  assert.equal(await settlePresses(), 1, "only the other member's press was queued; a forged value and a link button queue nothing")
  assert.equal((await requests()).length, before, "and it started nothing")
  assert.match(await averyBrowser.slackPage(), BUTTON, "the question is still open")

  const first = await post(press(averySlackId, "Send it"))
  const second = await post(press(averySlackId, "Don't send", 1))
  assert.deepEqual([first.status, second.status], [200, 200], summary(first))
  assert.equal((await requests()).length, before, "the route only queues the press: nothing has run and Slack has not been called")
  assert.match(await averyBrowser.slackPage(), BUTTON)

  assert.equal(await settlePresses(), 2)
  const queued = (await requests()).slice(before)
  assert.equal(queued.length, 1, "two presses, one request")
  assert.deepEqual([queued[0]?.slackUserId, queued[0]?.channelId, queued[0]?.threadTs, queued[0]?.status], [averySlackId, channel, ts, "pending"])
  assert.deepEqual(JSON.parse(queued[0]?.payload ?? "{}"), { type: "message", channel_type: "im", user: averySlackId, channel, text: "Send it", ts, thread_ts: ts })
  const page = await averyBrowser.slackPage()
  assert.match(page, /Send it from your Gmail\?/)
  assert.match(page, /chose <strong>Send it<\/strong>/, "Slack shows the answer that runs, not the later press")
  assert.doesNotMatch(page, /chose <strong>Don&#39;t send<\/strong>/)
  assert.doesNotMatch(page, BUTTON, "the buttons are gone")

  await post(press(averySlackId, "Send it"))
  assert.equal(await settlePresses(), 1)
  assert.equal((await requests()).length, before + 1, "pressing again later starts nothing new")
})

test("a question already in Slack starts nothing after the feature is turned off, and works again when it is back on", async () => {
  const { averySlackId, press, post } = await ask("The reply to Lee is drafted.")
  const before = (await requests()).length
  assert.equal((await den.setFeature(orgId, "slackRichMessages", false)).status, 200)
  assert.equal((await post(press(averySlackId, "Send it"))).status, 200)
  assert.equal(await settlePresses(), 1)
  assert.equal((await requests()).length, before, "off: the press starts nothing")
  assert.match(await averyBrowser.slackPage(), BUTTON, "and the question is left as it was")

  assert.equal((await den.setFeature(orgId, "slackRichMessages", true)).status, 200)
  assert.equal((await post(press(averySlackId, "Send it"))).status, 200)
  assert.equal(await settlePresses(), 1)
  assert.equal((await requests()).length, before + 1)
})

async function slackUserOf(person: Session) {
  const rows = await db
    .select({ slackUserId: SlackAssistantIdentityTable.slackUserId })
    .from(SlackAssistantIdentityTable)
    .innerJoin(MemberTable, eq(MemberTable.id, SlackAssistantIdentityTable.memberId))
    .where(and(eq(SlackAssistantIdentityTable.connectionId, normalizeDenTypeId("externalMcpConnection", connectionId)), eq(MemberTable.userId, normalizeDenTypeId("user", person.userId))))
  return text(rows[0]?.slackUserId, `Slack user of ${person.name}`)
}

test("choices are refused on a deployment with nothing to answer them, and text still goes out", async () => {
  delete process.env.DEN_HEADLESS_RUNNER_URL
  const refused = await send({ target: "me", text: "Another draft is ready.", components: [{ type: "choices", options: ["Send it", "Don't send"] }] })
  assert.equal(field(refused.body, "error"), "choices_unavailable", refused.raw)
  assert.doesNotMatch(await averyBrowser.slackPage(), /Another draft is ready/)
  const plain = await send({ target: "me", text: "Another draft is ready. Reply here to send it." })
  assert.equal(field(plain.body, "sent"), true, plain.raw)
})
