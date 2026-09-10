import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, expect, mock, test } from "bun:test"
import { Hono, type MiddlewareHandler } from "hono"
import { contextStorage, getContext } from "hono/context-storage"
import { generateSpecs } from "hono-openapi"
import { buildMcpCatalog } from "../src/mcp/catalog.js"
import type { ConnectedAccountRow } from "../src/capability-sources/oauth-credentials.js"
import type { OrganizationContext } from "../src/orgs.js"
import type { GoogleWorkspaceActionDependencies } from "../src/routes/org/google-workspace-actions.js"
import type { GoogleWorkspaceAccessToken } from "../src/routes/org/google-workspace.js"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"
import { jsonValidator, paramValidator, queryValidator } from "../src/middleware/validation.js"

// Only the outer organization lookup is synthetic. Hono validation, context storage,
// the Gmail routes and requestGoogleAction execute normally, with no database/provider I/O.
mock.module("../src/middleware/index.js", () => ({
  jsonValidator, paramValidator, queryValidator,
  orgMemberRoute: (): MiddlewareHandler<{ Variables: OrgRouteVariables }> => async (c, next) => {
    if (!c.get("organizationContext")) return c.json({ error: "unauthorized" }, 401)
    await next()
  },
}))
mock.module("../src/env.js", () => ({ env: { googleApiBaseUrl: undefined } }))
const { registerGmailManagementRoutes } = await import("../src/routes/org/gmail-management.js")
afterAll(() => mock.restore())

const MODIFY = "https://www.googleapis.com/auth/gmail.modify"
const COMPOSE = "https://www.googleapis.com/auth/gmail.compose"
const READ = "https://www.googleapis.com/auth/gmail.readonly"
const LABELS = "https://www.googleapis.com/auth/gmail.labels"
const prefix = "/v1/capabilities/google-workspace"
const sentMessage = { id: "sent-message", threadId: "existing-thread", labelIds: ["SENT"] }
const draft = { id: "draft-1", message: { id: "draft-message", threadId: "existing-thread", raw: "TWlNRSBjb250ZW50" } }
const label = { id: "Label_1", name: "Follow up", type: "user" }

function fixture(options: { scopes?: string[] | null; enabledScopes?: string[]; enabledFeatures?: string[]; tokenError?: "needs_connection" | "google_api_error"; reply?: () => Response | Promise<Response> } = {}) {
  const now = new Date("2026-01-01T00:00:00Z")
  const organizationId = createDenTypeId("organization")
  const memberId = createDenTypeId("member")
  const secondMemberId = createDenTypeId("member")
  const context: OrganizationContext = {
    organization: { id: organizationId, name: "Test", slug: "test", logo: null, allowedEmailDomains: null, metadata: null, createdAt: now, updatedAt: now },
    currentMember: { id: memberId, userId: createDenTypeId("user"), role: "member", directRole: "member", adminTeams: [], createdAt: now, joinedAt: now, isOwner: false },
    members: [], invitations: [], roles: [], teams: [],
  }
  const account: ConnectedAccountRow = {
    id: createDenTypeId("connectedAccount"), organizationId, orgMembershipId: memberId,
    providerId: "google-workspace", externalAccountId: "selected@example.test",
    scopes: options.scopes === undefined ? [MODIFY] : options.scopes,
    accessToken: "synthetic-selected-token", refreshToken: null, tokenType: "Bearer", expiresAt: null,
    pendingCodeVerifier: null, credentialHealth: null, connectedAt: now, updatedAt: now,
  }
  const calls: { url: string; method: string; headers: Headers; body: unknown }[] = []
  const selections: (Parameters<GoogleWorkspaceActionDependencies["token"]>[0] & { connector: string | undefined })[] = []
  const dependencies: GoogleWorkspaceActionDependencies = {
    token: async (input): Promise<GoogleWorkspaceAccessToken> => {
      const connector = getContext().req.header("x-test-selected-connector")
      selections.push({ ...input, connector })
      if (options.tokenError) return { kind: options.tokenError, message: "Synthetic credential unavailable." }
      const token: GoogleWorkspaceAccessToken = {
        kind: "ok", accessToken: `${account.accessToken}-${input.orgMembershipId}-${connector}`,
        account: { ...account, orgMembershipId: input.orgMembershipId },
        enabledScopes: options.enabledScopes ?? [MODIFY, COMPOSE, READ, LABELS],
        enabledFeatures: options.enabledFeatures ?? ["gmailManage"],
      }
      // Simulate a runtime dependency omitting the required field, without weakening the public type.
      if ("enabledScopes" in options && options.enabledScopes === undefined) Reflect.deleteProperty(token, "enabledScopes")
      return token
    },
    fetch: async (input, init) => {
      calls.push({
        url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      })
      return options.reply ? options.reply() : Response.json(sentMessage)
    },
  }
  const app = new Hono<{ Variables: OrgRouteVariables }>()
  app.use("*", contextStorage())
  app.use("*", async (c, next) => {
    if (c.req.header("x-test-member")) {
      c.set("organizationContext", {
        ...context, currentMember: { ...context.currentMember, id: c.req.header("x-test-member") === "second" ? secondMemberId : memberId },
      })
    }
    await next()
  })
  registerGmailManagementRoutes(app, dependencies)
  const request = (path: string, method = "GET", body?: unknown, member = "first", connector = "selected") => app.request(`${prefix}/${path}`, {
    method, headers: { "content-type": "application/json", "x-test-member": member, "x-test-selected-connector": connector },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { app, calls, selections, request, organizationId, memberId, secondMemberId }
}

test("send preserves an existing draft, forwards only its ID and returns Google's actual sent identifiers", async () => {
  const f = fixture({ scopes: [COMPOSE] })
  const response = await f.request("gmail-draft/draft%2Fwith%3Freserved/send", "POST", { confirm: true })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(sentMessage)
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]?.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts/send")
  expect(f.calls[0]?.method).toBe("POST")
  expect(f.calls[0]?.body).toEqual({ id: "draft/with?reserved" })
  expect(f.calls[0]?.headers.get("authorization")).toBe(`Bearer synthetic-selected-token-${f.memberId}-selected`)
  expect(f.calls[0]?.headers.get("content-type")).toBe("application/json")
  expect(f.selections).toEqual([{ organizationId: f.organizationId, orgMembershipId: f.memberId, connector: "selected" }])
})

test("enabling drafts alone never silently enables sending with the same OAuth grant", async () => {
  const draftsOnly = fixture({ scopes: [COMPOSE], enabledScopes: [COMPOSE], enabledFeatures: ["gmailDraft"] })
  expect((await draftsOnly.request("gmail-draft/draft-1/send", "POST", { confirm: true })).status).toBe(409)
  expect(draftsOnly.calls).toHaveLength(0)
  const sendEnabled = fixture({ scopes: [COMPOSE], enabledScopes: [COMPOSE], enabledFeatures: ["gmailSend"] })
  expect((await sendEnabled.request("gmail-draft/draft-1/send", "POST", { confirm: true })).status).toBe(200)
  expect(sendEnabled.calls).toHaveLength(1)
})

test("member and selected connector context reach credential resolution without cross-account fallback", async () => {
  const f = fixture()
  await f.request("gmail-draft/draft-1/send", "POST", { confirm: true }, "second", "other-selected")
  expect(f.selections).toEqual([{ organizationId: f.organizationId, orgMembershipId: f.secondMemberId, connector: "other-selected" }])
  expect(f.calls[0]?.headers.get("authorization")).toBe(`Bearer synthetic-selected-token-${f.secondMemberId}-other-selected`)
  expect(f.calls[0]?.headers.get("authorization")).not.toContain(f.memberId)
})

for (const scopes of [null, [], [READ], [LABELS], ["https://www.googleapis.com/auth/gmail.send"], ["https://mail.google.com/"]]) {
  test(`send fails closed on insufficient or unknown scopes: ${JSON.stringify(scopes)}`, async () => {
    const f = fixture({ scopes })
    const response = await f.request("gmail-draft/draft-1/send", "POST", { confirm: true })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: "needs_connection" })
    expect(f.calls).toHaveLength(0)
  })
}

for (const enabledScopes of [undefined, [], [READ]]) {
  test(`disabled or unknown connector permissions block stale Gmail write grants: ${JSON.stringify(enabledScopes)}`, async () => {
    const f = fixture({ scopes: [MODIFY, COMPOSE, LABELS], enabledScopes })
    for (const { path, method, body } of [
      { path: "gmail-draft/draft-1/send", method: "POST", body: { confirm: true } },
      { path: "gmail-draft/draft-1", method: "PUT", body: { confirm: true, message: { raw: draft.message.raw } } },
      { path: "gmail-draft/draft-1", method: "DELETE", body: { confirm: true } },
      { path: "gmail-message/message-1/modify", method: "POST", body: { addLabelIds: ["STARRED"] } },
      { path: "gmail-message/message-1/trash", method: "POST", body: { confirm: true } },
      { path: "gmail-message/message-1/untrash", method: "POST", body: { confirm: true } },
      { path: "gmail-labels", method: "POST", body: { name: "Follow up" } },
      { path: "gmail-label/Label_1", method: "PATCH", body: { name: "Renamed" } },
      { path: "gmail-label/Label_1", method: "DELETE", body: { confirm: true } },
    ]) {
      const response = await f.request(path, method, body)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: "needs_connection" })
    }
    expect(f.calls).toHaveLength(0)
  })
}

for (const tokenError of ["needs_connection", "google_api_error"] as const) {
  test(`credential failure ${tokenError} makes no provider request`, async () => {
    const f = fixture({ tokenError })
    const response = await f.request("gmail-draft/draft-1/send", "POST", { confirm: true })
    expect(response.status).toBe(tokenError === "needs_connection" ? 409 : 502)
    expect(f.calls).toHaveLength(0)
  })
}

const confirmedRoutes = [
  { path: "gmail-draft/draft-1/send", method: "POST" },
  { path: "gmail-draft/draft-1", method: "DELETE" },
  { path: "gmail-message/message-1/trash", method: "POST" },
  { path: "gmail-label/Label_1", method: "DELETE" },
]
for (const target of confirmedRoutes) {
  test(`${target.method} ${target.path} requires explicit true confirmation before credentials or fetch`, async () => {
    const f = fixture()
    for (const body of [{}, { confirm: false }, { confirm: "true" }, { confirm: true, userId: "another-user" }]) {
      expect((await f.request(target.path, target.method, body)).status).toBe(400)
    }
    expect(f.selections).toHaveLength(0)
    expect(f.calls).toHaveLength(0)
  })
}

for (const status of [401, 403, 404, 429, 500]) {
  test(`provider HTTP ${status} is sanitized and never retried`, async () => {
    const f = fixture({ reply: () => new Response("private provider error / token / raw mail", { status }) })
    const response = await f.request("gmail-draft/draft-1/send", "POST", { confirm: true })
    expect(response.status).toBe(status === 401 || status === 403 ? 409 : 502)
    expect(await response.text()).not.toContain("private provider error")
    expect(f.calls).toHaveLength(1)
  })
}

test("network failure after sending remains uncertain, sanitized and is not retried", async () => {
  const f = fixture({ reply: () => { throw new Error("private-network-detail") } })
  const response = await f.request("gmail-draft/draft-1/send", "POST", { confirm: true })
  expect(response.status).toBe(502)
  const text = await response.text()
  expect(text).toContain("may have completed")
  expect(text).not.toContain("private-network-detail")
  expect(f.calls).toHaveLength(1)
})

for (const body of ["not JSON", "null", "{}", '{"id":"sent"}', '{"id":"","threadId":"thread"}', '{"id":"sent","threadId":2}']) {
  test(`malformed successful send is not confirmed: ${body}`, async () => {
    const f = fixture({ reply: () => new Response(body, { status: 200 }) })
    const response = await f.request("gmail-draft/draft-1/send", "POST", { confirm: true })
    expect(response.status).toBe(502)
    expect(await response.text()).toContain("may have completed")
    expect(f.calls).toHaveLength(1)
  })
}

test("draft list passes pagination/search and preserves nextPageToken", async () => {
  const data = { drafts: [draft], nextPageToken: "page+2/next", resultSizeEstimate: 101 }
  const f = fixture({ scopes: [READ], reply: () => Response.json(data) })
  const response = await f.request("gmail-drafts?q=subject%3Areply&maxResults=100&pageToken=page%2B1%2Fnext&includeSpamTrash=false")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(data)
  expect(f.calls[0]?.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts?q=subject%3Areply&maxResults=100&pageToken=page%2B1%2Fnext&includeSpamTrash=false")
  expect((await f.request("gmail-drafts?maxResults=101")).status).toBe(400)
  expect((await f.request("gmail-drafts?includeSpamTrash=not-boolean")).status).toBe(400)
  expect(f.calls).toHaveLength(1)
})

test("draft read returns raw MIME and uses an encoded ID under users/me", async () => {
  const f = fixture({ scopes: [COMPOSE], reply: () => Response.json(draft) })
  const response = await f.request("gmail-draft/draft%2F%3F%23?format=raw")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(draft)
  expect(f.calls[0]?.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft%2F%3F%23?format=raw")
})

test("draft lists accept documented minimal messages and empty pages, not missing thread IDs", async () => {
  for (const data of [{ drafts: [{ id: draft.id, message: { id: draft.message.id, threadId: draft.message.threadId } }] }, {}, { drafts: [], resultSizeEstimate: 0 }]) {
    const f = fixture({ reply: () => Response.json(data) })
    const response = await f.request("gmail-drafts")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(data)
  }
  const f = fixture({ reply: () => Response.json({ drafts: [{ id: draft.id, message: { id: draft.message.id } }] }) })
  expect((await f.request("gmail-drafts")).status).toBe(502)
})

test("minimal and metadata draft reads allow an omitted threadId without weakening send confirmations", async () => {
  const data = { id: draft.id, message: { id: draft.message.id, labelIds: ["DRAFT"] } }
  const f = fixture({ reply: () => Response.json(data) })
  for (const format of ["minimal", "metadata"]) {
    const response = await f.request(`gmail-draft/draft-1?format=${format}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(data)
  }
  expect((await f.request("gmail-draft/draft-1?format=full")).status).toBe(502)
  expect((await f.request("gmail-draft/draft-1/send", "POST", { confirm: true })).status).toBe(502)
})

test("Gmail rejects requests above 6 MiB before JSON validation, credentials or provider access", async () => {
  const f = fixture()
  const response = await f.request("gmail-draft/draft-1", "PUT", { confirm: true, message: { raw: "A".repeat(6 * 1024 * 1024) } })
  expect(response.status).toBe(413)
  expect(f.selections).toHaveLength(0)
  expect(f.calls).toHaveLength(0)
})

test("Gmail accepts a complete response at the 6 MiB limit", async () => {
  const data = { ...draft, message: { ...draft.message, raw: "" } }
  data.message.raw = "A".repeat(6 * 1024 * 1024 - JSON.stringify(data).length)
  const f = fixture({ reply: () => Response.json(data) })
  const response = await f.request("gmail-draft/draft-1?format=raw")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(data)
})

test("Gmail cancels oversized decoded response streams even with absent or misleading content-length", async () => {
  for (const contentLength of [undefined, "1", String(6 * 1024 * 1024 + 1)]) {
    let cancelled = false
    const f = fixture({ reply: () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...sentMessage, extra: "\u00e9".repeat(3 * 1024 * 1024) })))
      },
      cancel() { cancelled = true },
    }), { headers: contentLength === undefined ? {} : { "content-length": contentLength } }) })
    const response = await f.request("gmail-draft/draft-1/send", "POST", { confirm: true })
    expect(response.status).toBe(502)
    expect(await response.text()).toContain("may have completed")
    expect(cancelled).toBe(true)
    expect(f.calls).toHaveLength(1)
  }
})

test("draft replacement forwards full caller-provided MIME and threading without rebuilding it", async () => {
  const f = fixture({ scopes: [COMPOSE], reply: () => Response.json(draft) })
  const message = { raw: draft.message.raw, threadId: draft.message.threadId }
  const response = await f.request("gmail-draft/draft-1", "PUT", { confirm: true, message })
  expect(response.status).toBe(200)
  expect(f.calls[0]?.method).toBe("PUT")
  expect(f.calls[0]?.body).toEqual({ message })
  expect((await f.request("gmail-draft/draft-1", "PUT", { message })).status).toBe(400)
  expect((await f.request("gmail-draft/draft-1", "PUT", { confirm: true, message: { raw: "not base64url!" } })).status).toBe(400)
  expect(f.calls).toHaveLength(1)
})

test("delete draft accepts Google's no-content response and sends no confirmation field upstream", async () => {
  const f = fixture({ scopes: [COMPOSE], reply: () => new Response(null, { status: 204 }) })
  const response = await f.request("gmail-draft/draft%2F1", "DELETE", { confirm: true })
  expect(await response.json()).toEqual({ ok: true })
  expect(f.calls[0]?.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft%2F1")
  expect(f.calls[0]?.method).toBe("DELETE")
  expect(f.calls[0]?.body).toBeUndefined()
})

for (const change of [
  { addLabelIds: [], removeLabelIds: ["INBOX"] },
  { addLabelIds: ["INBOX"], removeLabelIds: [] },
  { addLabelIds: [], removeLabelIds: ["UNREAD"] },
  { addLabelIds: ["UNREAD"], removeLabelIds: [] },
  { addLabelIds: ["STARRED", "Label_1"], removeLabelIds: [] },
  { addLabelIds: [], removeLabelIds: ["STARRED"] },
]) {
  test(`message labels perform the actual requested mailbox change: ${JSON.stringify(change)}`, async () => {
    const f = fixture()
    const response = await f.request("gmail-message/message%2F1/modify", "POST", change)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(sentMessage)
    expect(f.calls[0]?.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/message%2F1/modify")
    expect(f.calls[0]?.body).toEqual(change)
    expect(f.calls).toHaveLength(1)
  })
}

test("message modification cannot bypass trash confirmation or silently ignore invalid input", async () => {
  const f = fixture()
  for (const body of [{}, { addLabelIds: ["TRASH"] }, { removeLabelIds: ["TRASH"] }, { addLabelIds: ["SENT"] }, { addLabelIds: ["INBOX", "INBOX"] }, { addLabelIds: ["UNREAD"], removeLabelIds: ["UNREAD"] }, { addLabelIds: Array.from({ length: 101 }, (_, i) => `Label_${i}`) }, { addLabelIds: ["INBOX"], account: "other" }]) {
    expect((await f.request("gmail-message/message-1/modify", "POST", body)).status).toBe(400)
  }
  expect(f.calls).toHaveLength(0)
})

for (const operation of ["modify", "trash", "untrash"]) {
  test(`${operation} rejects compose, readonly and labels-only permissions`, async () => {
    const body = operation === "modify" ? { addLabelIds: ["STARRED"] } : { confirm: true }
    for (const scopes of [[COMPOSE], [READ], [LABELS], null]) {
      const f = fixture({ scopes })
      expect((await f.request(`gmail-message/message-1/${operation}`, "POST", body)).status).toBe(409)
      expect(f.calls).toHaveLength(0)
    }
  })
}

for (const operation of ["trash", "untrash"]) {
  test(`${operation} calls Google's dedicated endpoint with an empty upstream body`, async () => {
    const f = fixture()
    const response = await f.request(`gmail-message/message-1/${operation}`, "POST", { confirm: true })
    expect(response.status).toBe(200)
    expect(f.calls[0]?.url).toBe(`https://gmail.googleapis.com/gmail/v1/users/me/messages/message-1/${operation}`)
    expect(f.calls[0]?.body).toBeUndefined()
  })
}

test("list and create labels return actual provider resources with least privilege", async () => {
  const f = fixture({ scopes: [LABELS], reply: () => Response.json(f.calls.length === 1 ? { labels: [label] } : label) })
  expect(await (await f.request("gmail-labels")).json()).toEqual({ labels: [label] })
  const input = { name: "Follow up", labelListVisibility: "labelShow" }
  expect(await (await f.request("gmail-labels", "POST", input)).json()).toEqual(label)
  expect(f.calls[1]?.body).toEqual(input)
  expect(f.calls[1]?.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/labels")
})

test("label patch first verifies user ownership/type then performs a partial PATCH", async () => {
  const f = fixture({ scopes: [LABELS], reply: () => Response.json(label) })
  expect((await f.request("gmail-label/Label_1", "PATCH", { name: "Renamed" })).status).toBe(200)
  expect(f.calls.map((call) => call.method)).toEqual(["GET", "PATCH"])
  expect(f.calls[1]?.body).toEqual({ name: "Renamed" })
})

test("label deletion checks type and accepts documented empty JSON without deleting messages", async () => {
  const f = fixture({ scopes: [LABELS], reply: () => Response.json(f.calls.length === 1 ? label : {}) })
  expect(await (await f.request("gmail-label/Label_1", "DELETE", { confirm: true })).json()).toEqual({ ok: true })
  expect(f.calls.map((call) => [call.url, call.method])).toEqual([
    ["https://gmail.googleapis.com/gmail/v1/users/me/labels/Label_1", "GET"],
    ["https://gmail.googleapis.com/gmail/v1/users/me/labels/Label_1", "DELETE"],
  ])
  expect(f.calls[1]?.body).toBeUndefined()
})

for (const method of ["PATCH", "DELETE"]) {
  test(`${method} refuses system labels, wrong IDs, malformed reads and failed preflights without a write`, async () => {
    for (const reply of [
      () => Response.json({ id: "INBOX", name: "Inbox", type: "system" }),
      () => Response.json({ ...label, id: "different-label" }),
      () => Response.json({ id: "INBOX", name: "Inbox" }),
      () => new Response("private", { status: 403 }),
    ]) {
      const f = fixture({ reply })
      const response = await f.request("gmail-label/INBOX", method, method === "PATCH" ? { name: "Renamed" } : { confirm: true })
      expect(response.status).not.toBe(200)
      expect(f.calls).toHaveLength(1)
      expect(f.calls[0]?.method).toBe("GET")
    }
  })
}

test("label schemas reject empty patches, invalid visibility and provider-controlled fields", async () => {
  const f = fixture()
  for (const body of [{}, { name: "" }, { name: "New", type: "system" }, { name: "New", id: "INBOX" }, { name: "New", labelListVisibility: "show" }]) {
    expect((await f.request("gmail-labels", "POST", body)).status).toBe(400)
  }
  expect((await f.request("gmail-label/Label_1", "PATCH", {})).status).toBe(400)
  expect(f.calls).toHaveLength(0)
})

test("all routes are discoverable Capability Sources and gated before credential resolution", async () => {
  const f = fixture()
  const spec = await generateSpecs(f.app)
  expect(buildMcpCatalog(spec).map((operation) => operation.name).sort()).toEqual([
    "createGmailLabel", "deleteGmailDraft", "deleteGmailLabel", "getGmailDraft", "listGmailDrafts", "listGmailLabels",
    "sendGmailDraft", "trashGmailMessage", "untrashGmailMessage", "updateGmailDraft", "updateGmailLabel", "updateGmailMessageLabels",
  ].sort())
  let count = 0
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!operation || typeof operation !== "object" || !("tags" in operation)) continue
      expect(operation.tags).toContain("Capability Sources")
      expect((await f.app.request(path.replace(/\{[^}]+\}/g, "resource-1"), { method: method.toUpperCase() })).status).toBe(401)
      count += 1
    }
  }
  expect(count).toBe(12)
  expect(f.selections).toHaveLength(0)
  expect(f.calls).toHaveLength(0)
})
