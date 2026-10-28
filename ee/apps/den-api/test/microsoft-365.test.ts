import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { Hono } from "hono"
import { MicrosoftGraphClient, MicrosoftGraphMutationOutcomeUnknownError, MicrosoftGraphRequestError, htmlReplyBody } from "../src/capability-sources/microsoft-graph.js"

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
      scopes: ["Calendars.ReadWrite", "Chat.Read", "ChatMessage.Send", "Mail.ReadWrite"],
      enabledFeatures: ["calendarWrite", "teamsChatSend", "mailDraft"],
    }),
  })
  const post = (path: string, body: unknown) => app.request(`/v1/capabilities/microsoft-365/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
  return { app, calls: graphFetch.calls, post }
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

test("Outlook drafts stay plain text by default, store HTML only when asked, and reject unknown fields", async () => {
  const { calls, post } = routes(() => json(201, { id: "draft-1", isDraft: true }))
  const draft = { to: ["blair@example.test"], subject: "Plan", body: "<p>Hello</p>" }
  assert.equal((await post("mail-drafts", draft)).status, 200)
  assert.deepEqual(JSON.parse(String(calls[0].init.body)).body, { contentType: "Text", content: "<p>Hello</p>" })

  assert.equal((await post("mail-drafts", { ...draft, bodyContentType: "html" })).status, 200)
  assert.deepEqual(JSON.parse(String(calls[1].init.body)).body, { contentType: "HTML", content: "<p>Hello</p>" })

  for (const invalid of [{ ...draft, bodyContentType: "rtf" }, { ...draft, bodyContentType: "" }, { ...draft, content_type: "html" }]) {
    assert.equal((await post("mail-drafts", invalid)).status, 400)
  }
  assert.equal(calls.length, 2)
})

test("calendar event bodies can be HTML, and a body type without a body is refused", async () => {
  const { app, calls, post } = routes(() => json(201, { id: "event-1" }))
  const event = { subject: "Sync", start: "2026-11-02T10:00:00Z", end: "2026-11-02T10:30:00Z", body: "<b>Agenda</b>", bodyContentType: "html" }
  assert.equal((await post("calendar-events", event)).status, 200)
  assert.deepEqual(JSON.parse(String(calls[0].init.body)).body, { contentType: "HTML", content: "<b>Agenda</b>" })

  const patch = (body: unknown) => app.request("/v1/capabilities/microsoft-365/calendar-events/event-1", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
  assert.equal((await patch({ confirmNotifications: true, bodyContentType: "html" })).status, 400)
  assert.equal(calls.length, 1)

  const updates = graph(() => json(200, { id: "event-1" }))
  await updates.client.updateCalendarEvent("event-1", { body: "<b>New</b>", bodyContentType: "html" })
  await updates.client.updateCalendarEvent("event-1", { subject: "Renamed" })
  assert.deepEqual(JSON.parse(String(updates.calls[0].init.body)).body, { contentType: "HTML", content: "<b>New</b>" })
  assert.equal("body" in JSON.parse(String(updates.calls[1].init.body)), false)
})

test("Outlook attachments list with their kind, and only file attachments are downloaded", async () => {
  const listed = graph(() => json(200, { value: [
    { "@odata.type": "#microsoft.graph.fileAttachment", id: "att-file", name: "plan.pdf", contentType: "application/pdf", size: 4, isInline: false },
    { "@odata.type": "#microsoft.graph.itemAttachment", id: "att-item", name: "Forwarded", contentType: "", size: 900, isInline: false },
  ] }))
  assert.deepEqual((await listed.client.listMailAttachments("message-1")).map(({ id, kind }) => [id, kind]), [["att-file", "file"], ["att-item", "item"]])
  assert.equal(listed.calls[0].url.pathname, "/v1.0/me/messages/message-1/attachments")

  const file = graph(({ url }) => url.pathname.endsWith("/$value")
    ? new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
    : json(200, { "@odata.type": "#microsoft.graph.fileAttachment", id: "att-file", name: "plan.pdf", contentType: "application/pdf", size: 4 }))
  const downloaded = await file.client.getMailAttachment("message-1", "att-file")
  assert.equal(downloaded.contentBase64, Buffer.from([1, 2, 3, 4]).toString("base64"))
  assert.equal(file.calls[1].url.pathname, "/v1.0/me/messages/message-1/attachments/att-file/$value")

  const item = graph(() => json(200, { "@odata.type": "#microsoft.graph.itemAttachment", id: "att-item", name: "Forwarded" }))
  assert.equal((await item.client.getMailAttachment("message-1", "att-item")).contentUnavailableReason, "not_a_file")
  assert.equal(item.calls.length, 1)

  const large = graph(() => json(200, { "@odata.type": "#microsoft.graph.fileAttachment", id: "att-big", name: "video.mp4", size: 11 * 1024 * 1024 }))
  assert.equal((await large.client.getMailAttachment("message-1", "att-big")).contentUnavailableReason, "file_too_large")
  assert.equal(large.calls.length, 1)
})

test("an Outlook attachment is added once as a file attachment and never retried", async () => {
  const ok = graph(() => json(201, { "@odata.type": "#microsoft.graph.fileAttachment", id: "att-1", name: "plan.pdf" }))
  await ok.client.addMailAttachment("draft-1", { name: "plan.pdf", contentType: "application/pdf", content: new Uint8Array([1, 2]) })
  assert.equal(ok.calls.length, 1)
  assert.equal(ok.calls[0].init.redirect, "error")
  assert.deepEqual(JSON.parse(String(ok.calls[0].init.body)), {
    "@odata.type": "#microsoft.graph.fileAttachment", name: "plan.pdf", contentType: "application/pdf", contentBytes: "AQI=",
  })

  const lost = graph(() => { throw new TypeError("fetch failed") })
  await assert.rejects(lost.client.addMailAttachment("draft-1", { name: "plan.pdf", contentType: "application/pdf", content: new Uint8Array([1]) }), MicrosoftGraphMutationOutcomeUnknownError)
  assert.equal(lost.calls.length, 1)
})

function outlookRoutes(respond: (call: Call) => Response, features: { outlookAttachments: boolean } = { outlookAttachments: true }) {
  const graphFetch = graph(respond)
  const app = new Hono()
  const member: Parameters<typeof registerMicrosoft365Routes>[1]["memberRoute"] = async (c, next) => {
    c.set("organizationContext", { organization: { id: "org_unit" }, currentMember: { id: "member_unit" }, features } as never)
    await next()
  }
  registerMicrosoft365Routes(app as never, {
    graphBaseUrl: GRAPH,
    fetch: graphFetch.fetch,
    memberRoute: member,
    transportRoute: member,
    resolveAccessToken: async () => ({ kind: "ok", accessToken: "synthetic-token", scopes: ["Mail.Read", "Mail.ReadWrite"], enabledFeatures: ["mailRead", "mailDraft"] }),
  })
  const upload = (payload: unknown, files: File[]) => {
    const form = new FormData()
    for (const file of files) form.append("file", file)
    form.append("payload", JSON.stringify(payload))
    return app.request("/v1/direct-uploads/microsoft-365/mail-drafts", { method: "POST", body: form })
  }
  return { calls: graphFetch.calls, upload, get: (path: string) => app.request(`/v1/capabilities/microsoft-365/${path}`) }
}

const plan = () => new File([new Uint8Array([1, 2, 3])], "plan.pdf", { type: "application/pdf" })
const newDraft = { to: ["blair@example.test"], subject: "Plan", body: "Attached." }

test("a draft with workspace attachments is created, then each file is attached, and it is never sent", async () => {
  const { calls, upload } = outlookRoutes(({ url }) => url.pathname.endsWith("/attachments")
    ? json(201, { "@odata.type": "#microsoft.graph.fileAttachment", id: "att-1", name: "plan.pdf" })
    : json(201, { id: "draft-1", isDraft: true, subject: "Plan" }))
  const response = await upload(newDraft, [plan()])
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.draft.id, "draft-1")
  assert.equal(body.draft.hasAttachments, true)
  assert.deepEqual(body.attachments, [{ name: "plan.pdf", contentType: "application/pdf", size: 3 }])
  assert.deepEqual(calls.map(({ url, init }) => `${init.method} ${url.pathname}`), [
    "POST /v1.0/me/messages",
    "POST /v1.0/me/messages/draft-1/attachments",
  ])

  assert.equal((await upload({ ...newDraft, bodyContentType: "html" }, [plan()])).status, 200)
  assert.deepEqual(JSON.parse(String(calls[2].init.body)).body, { contentType: "HTML", content: "Attached." })
})

test("a reply draft with attachments uses createReply on the selected message", async () => {
  const { calls, upload } = outlookRoutes(({ url }) => url.pathname.endsWith("/attachments")
    ? json(201, { id: "att-1" })
    : json(201, { id: "reply-1", isDraft: true }))
  assert.equal((await upload({ replyToMessageId: "message-1", comment: "Here it is." }, [plan()])).status, 200)
  assert.equal(calls[0].url.pathname, "/v1.0/me/messages/message-1/createReply")
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { comment: "Here it is." })
})

test("an HTML reply draft keeps Outlook's quoted original and writes the reply above it", async () => {
  const quoted = '<html><head></head><body><hr><div id="divRplyFwdMsg">From: Alex</div><p>Original</p></body></html>'
  const { calls, upload } = outlookRoutes(({ url, init }) => {
    if (url.pathname.endsWith("/attachments")) return json(201, { id: "att-1" })
    if (init.method === "PATCH") return json(200, { id: "reply-1", isDraft: true, body: JSON.parse(String(init.body)).body })
    return json(201, { id: "reply-1", isDraft: true, body: { contentType: "html", content: quoted } })
  })
  const response = await upload({ replyToMessageId: "message-1", comment: "<p>Thanks, <a href=\"https://example.test\">here</a></p>", bodyContentType: "html" }, [plan()])
  assert.equal(response.status, 200)
  assert.deepEqual(calls.map(({ url, init }) => `${init.method} ${url.pathname}`), [
    "POST /v1.0/me/messages/message-1/createReply",
    "PATCH /v1.0/me/messages/reply-1",
    "POST /v1.0/me/messages/reply-1/attachments",
  ])
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {})
  assert.deepEqual(JSON.parse(String(calls[1].init.body)).body, {
    contentType: "HTML",
    content: '<html><head></head><body><div><p>Thanks, <a href="https://example.test">here</a></p></div><hr><div id="divRplyFwdMsg">From: Alex</div><p>Original</p></body></html>',
  })
  assert.equal((await response.json()).draft.bodyContentType, "HTML")
})

test("an HTML reply to a plain-text message escapes the quoted text, and a failed body write removes the draft", async () => {
  assert.equal(htmlReplyBody("<b>Hi</b>", "> a < b\n> c", "text"), "<div><b>Hi</b></div><br>&gt; a &lt; b<br>&gt; c")
  assert.equal(htmlReplyBody("<b>Hi</b>", "", "html"), "<div><b>Hi</b></div>")

  const { calls, client } = graph(({ init }) => init.method === "PATCH"
    ? json(409, { error: { code: "ErrorIrresolvableConflict" } })
    : init.method === "DELETE" ? new Response(null, { status: 204 }) : json(201, { id: "reply-1", isDraft: true, body: { contentType: "html", content: "<body></body>" } }))
  await assert.rejects(client.createMailReplyDraft("message-1", "<p>Hi</p>", "html"), MicrosoftGraphRequestError)
  assert.deepEqual(calls.map(({ url, init }) => `${init.method} ${url.pathname}`), [
    "POST /v1.0/me/messages/message-1/createReply",
    "PATCH /v1.0/me/messages/reply-1",
    "DELETE /v1.0/me/messages/reply-1",
  ])
})

test("when a file cannot be attached, the new draft moves to Deleted Items", async () => {
  const { calls, upload } = outlookRoutes(({ url, init }) => {
    if (init.method === "DELETE") return new Response(null, { status: 204 })
    if (url.pathname.endsWith("/attachments")) return json(413, { error: { code: "ErrorAttachmentSizeLimitExceeded" } })
    return json(201, { id: "draft-1", isDraft: true })
  })
  const response = await upload(newDraft, [plan()])
  assert.equal(response.status, 502)
  assert.match((await response.json()).message, /moved to Deleted Items/)
  assert.deepEqual(calls.map(({ url, init }) => `${init.method} ${url.pathname}`).at(-1), "DELETE /v1.0/me/messages/draft-1")
})

test("draft uploads refuse bad files or payloads before calling Outlook", async () => {
  const { calls, upload } = outlookRoutes(() => json(201, { id: "draft-1", isDraft: true }))
  assert.equal((await upload(newDraft, [])).status, 400)
  assert.equal((await upload(newDraft, [new File([new Uint8Array(3_000_001)], "big.bin")])).status, 400)
  assert.equal((await upload({ ...newDraft, replyToMessageId: "message-1" }, [plan()])).status, 400)
  assert.equal(calls.length, 0)
})

test("with Outlook attachments off, the routes are not found and Outlook is never called", async () => {
  const { calls, upload, get } = outlookRoutes(() => json(200, { value: [] }), { outlookAttachments: false })
  assert.equal((await get("mail-attachments/message-1")).status, 404)
  assert.equal((await get("mail-attachment/message-1/att-1")).status, 404)
  assert.equal((await upload(newDraft, [plan()])).status, 404)
  assert.equal(calls.length, 0)
})

test("Outlook attachment reads leave the capability catalog while the rollout is off", async () => {
  const { nativeOperationAvailableToCapabilities } = await import("../src/mcp/catalog-availability.js")
  for (const path of ["/v1/capabilities/microsoft-365/mail-attachments/{messageId}", "/v1/capabilities/microsoft-365/mail-attachment/{messageId}/{attachmentId}"]) {
    assert.equal(nativeOperationAvailableToCapabilities({ outlookAttachmentsEnabled: false }, { path }), false)
    assert.equal(nativeOperationAvailableToCapabilities({ outlookAttachmentsEnabled: true }, { path }), true)
  }
  assert.equal(nativeOperationAvailableToCapabilities({ outlookAttachmentsEnabled: false }, { path: "/v1/capabilities/microsoft-365/mail-message/{messageId}" }), true)
})
