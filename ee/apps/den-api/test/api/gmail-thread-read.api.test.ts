import assert from "node:assert/strict"
import { after, test } from "node:test"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, startFakeHttpServer, summary } from "./harness.js"

const base = "/v1/capabilities/google-workspace"
const gmailRead = "https://www.googleapis.com/auth/gmail.readonly"
const headers = {
  From: "sender@example.test",
  To: "recipient@example.test",
  Cc: "copy@example.test",
  Bcc: "hidden@example.test",
  "Reply-To": "replies@example.test",
  Subject: "A conversation",
  Date: "Tue, 03 Nov 2026 12:00:00 +0000",
}
const metadata = {
  id: "earlier",
  threadId: "thread",
  internalDate: "900",
  labelIds: ["STARRED", "INBOX", "Label_42"],
  snippet: "Opening message",
  payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
}
const expectedMetadata = {
  id: "earlier", threadId: "thread", internalDate: 900, labelIds: metadata.labelIds,
  snippet: metadata.snippet, from: headers.From, to: headers.To, cc: headers.Cc,
  bcc: headers.Bcc, replyTo: headers["Reply-To"], subject: headers.Subject, date: headers.Date,
}
const calls: { url: URL; method: string | undefined; authorization: string | undefined }[] = []
const google = await startFakeHttpServer((request, _body, response) => {
  const url = new URL(request.url ?? "/", "http://example.test")
  calls.push({ url, method: request.method, authorization: request.headers.authorization })
  const reply = (status: number, payload: object) => {
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload))
  }
  if (url.pathname === "/gmail/v1/users/me/threads/thread") {
    reply(200, { id: "thread", historyId: "12345678901234567890", messages: [
      { ...metadata, id: "later", internalDate: "1000", labelIds: ["SENT", "DRAFT", "TRASH"], snippet: "Follow-up",
        payload: { headers: [{ name: "Date", value: "Mon, 02 Nov 2026 12:00:00 +0000" }] } },
      metadata,
    ] })
  } else if (url.pathname === "/gmail/v1/users/me/threads/empty") {
    reply(200, { id: "empty", messages: [] })
  } else if (url.pathname.startsWith("/gmail/v1/users/me/messages/")) {
    const body = url.pathname.endsWith("/long") ? "x".repeat(100_001) : "Plain body"
    reply(200, { ...metadata, payload: {
      ...metadata.payload, mimeType: "text/plain", body: { data: Buffer.from(body).toString("base64url") },
    } })
  } else {
    reply(503, { error: "unavailable" })
  }
})
after(() => google.close())
const den = await bootDen({ env: { DEN_GOOGLE_API_BASE_URL: google.url } })
after(() => den.close())
const { upsertConnectedAccount, upsertOrgOAuthClient } = await import("../../src/capability-sources/oauth-credentials.js")
const { orgId, owner } = await den.createOrg(await den.signUp("Gmail Reader"), "Gmail read test")
const api = den.as(owner, orgId)
const key = {
  organizationId: normalizeDenTypeId("organization", orgId),
  orgMembershipId: normalizeDenTypeId("member", owner.memberId),
  providerId: "google-workspace",
}
await upsertOrgOAuthClient({ ...key, clientId: "fixture-client", createdByOrgMembershipId: key.orgMembershipId })

function connect(scopes: string[]) {
  return upsertConnectedAccount({ ...key, accessToken: "fixture-access", tokenType: "Bearer", scopes, expiresAt: new Date(Date.now() + 3_600_000) })
}

const capability = "native:google-workspace:getCapabilitiesGoogleWorkspaceGmailThread"
const { gmailReadTokenError } = await import("../../src/routes/org/google-workspace.js")

test("a blocked Google Workspace policy maps to 403 and policy_blocked", () => {
  const message = "The organization is unavailable."
  assert.deepEqual(gmailReadTokenError({ kind: "policy_blocked", message }), {
    status: 403, body: { error: "policy_blocked", message },
  })
})

test("the default-off flag blocks direct reads and hides the native thread tool", async () => {
  await connect([gmailRead])
  const denied = await api("GET", `${base}/gmail-thread/thread`)
  assert.equal(denied.status, 404, summary(denied))
  assert.equal(field(denied.body, "error"), "feature_disabled")
  assert.equal(calls.length, 0)
  const token = await den.mintMcpToken(owner, orgId)
  const found = await den.callMcpTool(token, "search_capabilities", { query: "Gmail thread", type: "api", limit: 20 })
  assert.equal(found.status, 200)
  assert.equal(found.isError, false, found.text)
  assert.equal(list(field(found.structured ?? found.body, "matches")).some((match) => match.name === capability), false)
  const refused = await den.callMcpTool(token, "execute_capability", { name: capability, path: { threadId: "thread" } })
  assert.equal(refused.isError, true)
  assert.equal(calls.length, 0)
  const message = await api("GET", `${base}/gmail-message/short`)
  assert.equal(message.status, 200, summary(message))
  assert.equal(field(message.body, "message", "body"), "Plain body")
  calls.length = 0
  const { disconnectAccount } = await import("../../src/capability-sources/oauth-credentials.js")
  await disconnectAccount(key)
  const enabled = await den.setFeature(orgId, "gmailThreadRead", true)
  assert.equal(enabled.status, 200, summary(enabled))
})

test("Gmail thread read refuses unauthenticated, unconnected and under-scoped requests without calling Google", async () => {
  const path = `${base}/gmail-thread/thread`
  const unsigned = await den.request(null, "GET", path, { orgId })
  assert.equal(unsigned.status, 401, summary(unsigned))
  const disconnected = await api("GET", path)
  assert.equal(disconnected.status, 409, summary(disconnected))
  assert.equal(field(disconnected.body, "error"), "needs_connection")
  await connect(["https://www.googleapis.com/auth/calendar.readonly"])
  const unscoped = await api("GET", path)
  assert.equal(unscoped.status, 409, summary(unscoped))
  assert.equal(field(unscoped.body, "error"), "needs_connection")
  assert.match(String(field(unscoped.body, "message")), /Gmail read/)
  assert.equal(calls.length, 0)
})

test("Gmail thread read makes one metadata request and sorts by internal time, not the Date header", async () => {
  await connect([gmailRead])
  const response = await api("GET", `${base}/gmail-thread/thread`)
  assert.equal(response.status, 200, summary(response))
  assert.deepEqual(response.body, { ok: true, threadId: "thread", historyId: "12345678901234567890", messages: [
    expectedMetadata,
    { id: "later", threadId: "thread", internalDate: 1000, date: "Mon, 02 Nov 2026 12:00:00 +0000",
      from: "", to: "", cc: "", bcc: "", replyTo: "", subject: "", labelIds: ["SENT", "DRAFT", "TRASH"], snippet: "Follow-up" },
  ] })
  assert.equal(calls.length, 1)
  const [call] = calls
  assert.ok(call)
  assert.equal(call.method, "GET")
  assert.equal(call.authorization, "Bearer fixture-access")
  assert.equal(call.url.pathname, "/gmail/v1/users/me/threads/thread")
  assert.deepEqual(call.url.searchParams.getAll("format"), ["metadata"])
  assert.deepEqual(call.url.searchParams.getAll("metadataHeaders"), Object.keys(headers))
  const empty = await api("GET", `${base}/gmail-thread/empty`)
  assert.deepEqual(empty.body, { ok: true, threadId: "empty", messages: [] })
})

test("Gmail thread read reports upstream errors as 502", async () => {
  await connect([gmailRead])
  const response = await api("GET", `${base}/gmail-thread/unavailable`)
  assert.equal(response.status, 502, summary(response))
  assert.equal(field(response.body, "error"), "google_api_error")
})

test("Gmail message read preserves its response and indicates whether the body was trimmed", async () => {
  await connect([gmailRead])
  for (const [id, body, bodyTruncated] of [["short", "Plain body", false], ["long", "x".repeat(100_000), true]] as const) {
    const response = await api("GET", `${base}/gmail-message/${id}`)
    assert.equal(response.status, 200, summary(response))
    assert.deepEqual(response.body, { ok: true, message: { ...expectedMetadata, body, bodyTruncated, attachments: [] } })
  }
})

test("search_capabilities finds separate thread, message and message-list operations", async () => {
  await connect([gmailRead])
  const token = await den.mintMcpToken(owner, orgId)
  for (const [path, name, pathParams, query] of [
    ["gmail-thread/{threadId}", "getCapabilitiesGoogleWorkspaceGmailThread", ["threadId"], "Gmail thread"],
    ["gmail-message/{messageId}", "getCapabilitiesGoogleWorkspaceGmailMessage", ["messageId"], "Gmail message"],
    ["gmail-messages", "getCapabilitiesGoogleWorkspaceGmailMessages", [], "Gmail messages"],
  ] as const) {
    const result = await den.callMcpTool(token, "search_capabilities", { query, type: "api", limit: 20 })
    assert.equal(result.status, 200)
    assert.equal(result.isError, false, result.text)
    const matches = list(field(result.structured ?? result.body, "matches"))
    const match = matches.find((entry) => entry.path === `${base}/${path}`)
    assert.ok(match, `missing ${path}`)
    assert.equal(match.name, `native:google-workspace:${name}`)
    assert.deepEqual(match.pathParams, pathParams)
    assert.equal(match.method, "GET")
    assert.ok(match.outputSchema)
  }
  const read = await den.callMcpTool(token, "execute_capability", {
    name: capability,
    path: { threadId: "empty" },
  })
  assert.equal(read.status, 200)
  assert.equal(read.isError, false, read.text)
  assert.deepEqual(read.body, { ok: true, threadId: "empty", messages: [] })
})
