import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { Hono } from "hono"
import { MicrosoftGraphClient, MicrosoftGraphMutationOutcomeUnknownError, MicrosoftGraphRequestError } from "../src/capability-sources/microsoft-graph.js"

// Routes are exercised with an injected member, token and Graph fetch; the
// modules' default adapters still need a valid local configuration at import.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/microsoft_365_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-microsoft-365-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-microsoft-365-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { db } = await import("../src/db.js")
// Better Auth seeds its resource registry on import. Return an already-present
// synthetic registry row while the modules initialize, without SQL I/O.
const bootstrapSelect = mock.method(db, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://unit.test/mcp/agent", policyVersion: 1 }] } } },
}))
const { auth } = await import("../src/auth.js")
await auth.$context
bootstrapSelect.mock.restore()
const { registerMicrosoft365Routes } = await import("../src/routes/org/microsoft-365.js")

type Call = { url: URL; init: RequestInit }
const GRAPH = "https://graph.unit.test/v1.0"

function graph(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: new URL(String(input)), init: init ?? {} }
    calls.push(call)
    return respond(call)
  }) as typeof globalThis.fetch
  return { calls, client: new MicrosoftGraphClient({ accessToken: "synthetic-token", baseUrl: GRAPH, fetch }), fetch }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

test("Teams senders keep their Entra user id instead of the shared identity type", async () => {
  const { client } = graph(() => json(200, { value: [{ id: "m1", body: { content: "hi" }, from: { user: { id: "user-alex", displayName: "Alex", userIdentityType: "aadUser" } } }] }))
  const [message] = await client.listTeamsMessages("chat-1", 5)
  assert.deepEqual(message.from, { name: "Alex", address: "user-alex" })
})

test("OneDrive search keeps ?, #, % and quotes inside the search path", async () => {
  const { calls, client } = graph(() => json(200, { value: [] }))
  await client.searchDriveItems({ query: "Q3 plan? #2 Alex's 100%", maxResults: 5 })
  const { url } = calls[0]
  assert.equal(decodeURIComponent(url.pathname), "/v1.0/me/drive/root/search(q='Q3 plan? #2 Alex''s 100%')")
  assert.equal(url.hash, "")
  assert.equal(url.searchParams.get("$top"), "5")
})

const writes: { name: string; status: number; receipt: unknown; run: (client: MicrosoftGraphClient) => Promise<unknown> }[] = [
  { name: "mail draft create", status: 201, receipt: { id: "draft-1", isDraft: true }, run: (client) => client.createMailDraft({ to: ["blair@example.test"], subject: "Plan", body: "Draft" }) },
  { name: "calendar event create", status: 201, receipt: { id: "event-1" }, run: (client) => client.createCalendarEvent({ subject: "Sync", start: "2026-11-02T10:00:00", end: "2026-11-02T10:30:00", timeZone: "UTC" }) },
  { name: "OneDrive file write", status: 201, receipt: { id: "file-1", file: {} }, run: (client) => client.putDriveTextFile({ path: "Notes/plan.md", content: "# Plan" }) },
  { name: "Teams message send", status: 201, receipt: { id: "message-1" }, run: (client) => client.sendTeamsMessage("chat-1", "hello") },
]

for (const write of writes) {
  test(`${write.name} is sent once, refuses redirects and reports an unknown outcome instead of retrying`, async () => {
    const ok = graph(() => json(write.status, write.receipt))
    await write.run(ok.client)
    assert.equal(ok.calls.length, 1)
    assert.equal(ok.calls[0].init.redirect, "error")

    const lost = graph(() => { throw new TypeError("fetch failed") })
    await assert.rejects(write.run(lost.client), MicrosoftGraphMutationOutcomeUnknownError)
    assert.equal(lost.calls.length, 1)

    const unexpected = graph(() => json(202, {}))
    await assert.rejects(write.run(unexpected.client), MicrosoftGraphMutationOutcomeUnknownError)

    const noReceipt = graph(() => json(write.status, {}))
    await assert.rejects(write.run(noReceipt.client), MicrosoftGraphMutationOutcomeUnknownError)

    const rejected = graph(() => json(403, { error: { code: "Forbidden" } }))
    await assert.rejects(write.run(rejected.client), (error) => error instanceof MicrosoftGraphRequestError
      && !(error instanceof MicrosoftGraphMutationOutcomeUnknownError) && error.status === 403)
  })
}

test("OneDrive file write sends text content and accepts Graph's replace receipt", async () => {
  const { calls, client } = graph(() => json(200, { id: "file-1", name: "plan.md", file: { mimeType: "text/markdown" } }))
  const file = await client.putDriveTextFile({ path: "Notes/plan.md", content: "# Plan" })
  assert.equal(file.id, "file-1")
  assert.equal(calls[0].init.method, "PUT")
  assert.equal(new Headers(calls[0].init.headers).get("content-type"), "text/plain; charset=utf-8")
  assert.equal(calls[0].init.body, "# Plan")
  assert.equal(calls[0].url.pathname, "/v1.0/me/drive/root:/Notes/plan.md:/content")
})

function routes(respond: (call: Call) => Response) {
  const graphFetch = graph(respond)
  const app = new Hono()
  registerMicrosoft365Routes(app as never, {
    graphBaseUrl: GRAPH,
    fetch: graphFetch.fetch,
    memberRoute: async (c, next) => {
      c.set("organizationContext", { organization: { id: "org_unit" }, currentMember: { id: "member_unit" } } as never)
      await next()
    },
    resolveAccessToken: async () => ({
      kind: "ok",
      accessToken: "synthetic-token",
      scopes: ["Calendars.ReadWrite", "Chat.Read", "ChatMessage.Send"],
      enabledFeatures: ["calendarWrite", "teamsChatSend"],
    }),
  })
  const post = (path: string, body: unknown) => app.request(`/v1/capabilities/microsoft-365/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
  return { calls: graphFetch.calls, post }
}

test("Teams messages are sent only with explicit confirmation, which is not forwarded to Graph", async () => {
  const { calls, post } = routes(() => json(201, { id: "message-1", body: { content: "hello" } }))
  assert.equal((await post("teams-chats/chat-1/messages", { content: "hello" })).status, 400)
  assert.equal(calls.length, 0)

  assert.equal((await post("teams-chats/chat-1/messages", { content: "hello", confirmSend: true })).status, 200)
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { body: { contentType: "text", content: "hello" } })
})

test("calendar invitations need confirmation, while events without attendees do not", async () => {
  const { calls, post } = routes(() => json(201, { id: "event-1" }))
  const event = { subject: "Sync", start: "2026-11-02T10:00:00Z", end: "2026-11-02T10:30:00Z" }
  assert.equal((await post("calendar-events", { ...event, attendees: ["blair@example.test"] })).status, 400)
  assert.equal(calls.length, 0)

  assert.equal((await post("calendar-events", event)).status, 200)
  assert.equal((await post("calendar-events", { ...event, attendees: ["blair@example.test"], confirmNotifications: true })).status, 200)
  assert.equal(calls.length, 2)
  const invite = JSON.parse(String(calls[1].init.body))
  assert.deepEqual(invite.attendees, [{ emailAddress: { address: "blair@example.test" }, type: "required" }])
  assert.equal("confirmNotifications" in invite, false)
})
