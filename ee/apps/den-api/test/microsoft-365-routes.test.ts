import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, spyOn, test } from "bun:test"
import { Hono, type MiddlewareHandler } from "hono"
import { generateSpecs } from "hono-openapi"
import { buildMcpCatalog } from "../src/mcp/catalog.js"
import type { OrganizationContext } from "../src/orgs.js"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let routes: typeof import("../src/routes/org/microsoft-365.js")

beforeAll(async () => {
  seedRequiredEnv()
  routes = await import("../src/routes/org/microsoft-365.js")
})

function organizationContext(): OrganizationContext {
  const now = new Date("2026-07-09T00:00:00Z")
  return {
    organization: {
      id: createDenTypeId("organization"),
      name: "Microsoft Routes Test",
      slug: `microsoft-routes-${crypto.randomUUID()}`,
      logo: null,
      allowedEmailDomains: null,
      metadata: null,
      createdAt: now,
      updatedAt: now,
    },
    currentMember: {
      id: createDenTypeId("member"),
      userId: createDenTypeId("user"),
      role: "member",
      createdAt: now,
      joinedAt: now,
      isOwner: false,
    },
    members: [],
    invitations: [],
    roles: [],
    teams: [],
  }
}

function contextMiddleware(context: OrganizationContext): MiddlewareHandler<{ Variables: OrgRouteVariables }> {
  return async (c, next) => {
    c.set("organizationContext", context)
    await next()
  }
}

function driveFileApp(graphFetch: typeof fetch): Hono<{ Variables: OrgRouteVariables }> {
  const app = new Hono<{ Variables: OrgRouteVariables }>()
  routes.registerMicrosoft365Routes(app, {
    graphBaseUrl: "https://graph.example.test/v1.0",
    fetch: graphFetch,
    memberRoute: contextMiddleware(organizationContext()),
    resolveAccessToken: async () => ({
      kind: "ok",
      accessToken: "delegated-member-token",
      scopes: ["Files.Read"],
      enabledFeatures: ["filesRead"],
    }),
  })
  return app
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const mutationCases: Array<{
  name: string
  method: "POST" | "PATCH" | "DELETE"
  path: string
  body: Record<string, unknown>
  feature: string
  scope: string
  graphPath: string
  graphBody: unknown
  graphStatus: number
  graphResponse: unknown
  receipt: unknown
}> = [
  {
    name: "send draft", method: "POST", path: "mail-drafts/draft_1/send", body: { confirmSend: true },
    feature: "mailSend", scope: "Mail.Send", graphPath: "me/messages/draft_1/send", graphBody: null,
    graphStatus: 202, graphResponse: null, receipt: { ok: true, draftId: "draft_1", status: "accepted" },
  },
  {
    name: "reply draft", method: "POST", path: "mail-message/message_1/reply-draft", body: { comment: "Reply for review" },
    feature: "mailDraft", scope: "Mail.ReadWrite", graphPath: "me/messages/message_1/createReply", graphBody: { comment: "Reply for review" },
    graphStatus: 201, graphResponse: { id: "reply_1", isDraft: true, conversationId: "thread_1" },
    receipt: { ok: true, draft: { id: "reply_1", isDraft: true, conversationId: "thread_1" } },
  },
  {
    name: "update message", method: "PATCH", path: "mail-message/message_1", body: { isRead: false, categories: [] },
    feature: "mailManage", scope: "Mail.ReadWrite", graphPath: "me/messages/message_1", graphBody: { isRead: false, categories: [] },
    graphStatus: 200, graphResponse: { id: "message_1", isRead: false, categories: [] },
    receipt: { ok: true, message: { id: "message_1", isRead: false, categories: [] } },
  },
  {
    name: "move message", method: "POST", path: "mail-message/message_1/move", body: { destination: "deleteditems", confirmTrash: true },
    feature: "mailManage", scope: "Mail.ReadWrite", graphPath: "me/messages/message_1/move", graphBody: { destinationId: "deleteditems" },
    graphStatus: 201, graphResponse: { id: "moved_1", parentFolderId: "deleted_1" },
    receipt: { ok: true, message: { id: "moved_1", parentFolderId: "deleted_1" } },
  },
  {
    name: "reschedule event", method: "PATCH", path: "calendar-events/event_1",
    body: { start: "2026-09-10T10:00:00Z", end: "2026-09-10T11:00:00Z", confirmNotifications: true },
    feature: "calendarWrite", scope: "Calendars.ReadWrite", graphPath: "me/events/event_1",
    graphBody: { start: { dateTime: "2026-09-10T10:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-09-10T11:00:00Z", timeZone: "UTC" } },
    graphStatus: 200, graphResponse: { id: "event_1", start: { dateTime: "2026-09-10T10:00:00Z", timeZone: "UTC" } },
    receipt: { ok: true, event: { id: "event_1", start: "2026-09-10T10:00:00Z" } },
  },
  {
    name: "cancel event", method: "POST", path: "calendar-events/event_1/cancel", body: { confirmCancel: true, comment: "Cancelled" },
    feature: "calendarWrite", scope: "Calendars.ReadWrite", graphPath: "me/events/event_1/cancel", graphBody: { comment: "Cancelled" },
    graphStatus: 202, graphResponse: null, receipt: { ok: true, eventId: "event_1", status: "accepted" },
  },
  {
    name: "delete event", method: "DELETE", path: "calendar-events/event_1", body: { confirmDelete: true },
    feature: "calendarWrite", scope: "Calendars.ReadWrite", graphPath: "me/events/event_1", graphBody: null,
    graphStatus: 204, graphResponse: null, receipt: { ok: true, eventId: "event_1", status: "deleted" },
  },
  {
    name: "rename and move file", method: "PATCH", path: "drive-file/item_1", body: { name: "Plan.txt", parentId: "folder_1" },
    feature: "filesWrite", scope: "Files.ReadWrite", graphPath: "me/drive/items/item_1", graphBody: { name: "Plan.txt", parentReference: { id: "folder_1" } },
    graphStatus: 200, graphResponse: { id: "item_1", name: "Plan.txt", file: { mimeType: "text/plain" } },
    receipt: { ok: true, file: { id: "item_1", name: "Plan.txt" } },
  },
  {
    name: "create folder", method: "POST", path: "drive-folders", body: { name: "Plans", parentId: "folder_1" },
    feature: "filesWrite", scope: "Files.ReadWrite", graphPath: "me/drive/items/folder_1/children",
    graphBody: { name: "Plans", folder: {}, "@microsoft.graph.conflictBehavior": "fail" },
    graphStatus: 201, graphResponse: { id: "folder_2", name: "Plans", folder: {} },
    receipt: { ok: true, file: { id: "folder_2", name: "Plans", kind: "folder" } },
  },
]

describe("Microsoft 365 bounded management routes", () => {
  test("default resolver binds named connector configuration and token reads without a legacy fallback", async () => {
    const credentials = await import("../src/capability-sources/oauth-credentials.js")
    const connections = await import("../src/capability-sources/native-provider-connections.js")
    const registry = await import("../src/capability-sources/provider-registry.js")
    const orgs = await import("../src/orgs.js")
    const session = await import("../src/session.js")
    const context = organizationContext()
    const otherContext = { ...context, currentMember: organizationContext().currentMember }
    const teamId = createDenTypeId("team")
    const writerId = createDenTypeId("externalMcpConnection")
    const wrongProviderId = createDenTypeId("externalMcpConnection")
    const unavailableId = createDenTypeId("externalMcpConnection")
    const now = new Date()
    let memberContext = context
    let features = ["mailSend"]
    let scopes: string[] | null = ["Mail.Send"]
    let connected = true
    let configured = true
    let defaultCredentialId: string | null = "microsoft-365"
    const provider = registry.getNativeOAuthProvider("microsoft-365")
    const otherProvider = registry.getNativeOAuthProvider("google-workspace")
    if (!provider || !otherProvider) throw new Error("Expected registered native providers")
    const writer = connections.buildNativeProviderEntry(provider, { clientConfigured: true, connectedForMe: true, credentialProviderId: writerId, name: "Work mailbox" })
    const other = connections.buildNativeProviderEntry(otherProvider, { clientConfigured: true, connectedForMe: true, credentialProviderId: wrongProviderId })
    if (!writer || !other) throw new Error("Expected configured native entries")

    const teams = spyOn(orgs, "listTeamsForMember").mockResolvedValue([
      { id: teamId, organizationId: context.organization.id, name: "Writers", createdAt: now, updatedAt: now },
    ])
    const usable = spyOn(connections, "listNativeProviderUsableEntries").mockImplementation(async (input) => (
      input.organizationId === context.organization.id && input.orgMembershipId === context.currentMember.id ? [writer, other] : []
    ))
    const defaults = spyOn(connections, "resolveDefaultNativeProviderCredentialId").mockImplementation(async () => defaultCredentialId)
    const clients = spyOn(credentials, "getOrgOAuthClient").mockImplementation(async (organizationId, providerId) => {
      if (!configured && providerId === writerId) return null
      return {
        id: createDenTypeId("orgOAuthClient"), organizationId, providerId, clientId: `client-${providerId}`,
        clientSecret: null, extra: { features: providerId === writerId ? features : ["mailSend"] },
        createdByOrgMembershipId: context.currentMember.id, createdAt: now, updatedAt: now,
      }
    })
    const accounts = spyOn(credentials, "getConnectedAccount").mockImplementation(async (input) => {
      if (input.providerId === writerId && !connected) return null
      return {
        id: createDenTypeId("connectedAccount"), ...input, externalAccountId: "fixture@example.test",
        accessToken: input.providerId === writerId ? "named-writer-token" : "legacy-token",
        scopes: input.providerId === writerId ? scopes : ["Mail.Send"], refreshToken: null, tokenType: "Bearer",
        expiresAt: null, pendingCodeVerifier: null, credentialHealth: null, connectedAt: now, updatedAt: now,
      }
    })
    const requests: Request[] = []
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerMicrosoft365Routes(app, {
      memberRoute: async (c, next) => { c.set("organizationContext", memberContext); await next() },
      fetch: async (input, init) => { requests.push(new Request(input, init)); return new Response(null, { status: 202 }) },
    })
    const request = (connectorId?: string, corruptHeader = false) => {
      const identity = { userId: memberContext.currentMember.userId, organizationId: memberContext.organization.id }
      const headers = new Headers({ "content-type": "application/json", "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader(identity) })
      if (connectorId) headers.set(session.INTERNAL_CAPABILITY_CONNECTOR_HEADER,
        corruptHeader ? "invalid-selection" : session.createInternalCapabilityConnectorHeader({ ...identity, connectorId }))
      return app.request("http://den-api.local/v1/capabilities/microsoft-365/mail-drafts/draft_1/send", {
        method: "POST", headers, body: JSON.stringify({ confirmSend: true }),
      })
    }
    try {
      const sent = await request(writerId)
      expect(sent.status).toBe(200)
      expect(await sent.json()).toEqual({ ok: true, draftId: "draft_1", status: "accepted" })
      expect(teams).toHaveBeenCalledWith({ organizationId: context.organization.id, memberId: context.currentMember.id })
      expect(usable).toHaveBeenCalledWith({ organizationId: context.organization.id, orgMembershipId: context.currentMember.id, teamIds: [teamId] })
      expect(clients).toHaveBeenCalledWith(context.organization.id, writerId)
      expect(accounts).toHaveBeenCalledWith({ organizationId: context.organization.id, orgMembershipId: context.currentMember.id, providerId: writerId })
      expect(defaults).not.toHaveBeenCalled()
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer named-writer-token")

      // A privileged legacy account must not rescue a disabled, under-scoped,
      // disconnected, or inaccessible explicitly selected named connector.
      features = ["mailRead"]
      expect((await request(writerId)).status).toBe(409)
      features = ["mailSend"]
      scopes = ["Mail.ReadWrite"]
      expect((await request(writerId)).status).toBe(409)
      scopes = null
      expect((await request(writerId)).status).toBe(409)
      scopes = ["Mail.Send"]
      connected = false
      expect((await request(writerId)).status).toBe(409)
      connected = true
      configured = false
      const accountReads = accounts.mock.calls.length
      expect((await request(writerId)).status).toBe(409)
      expect(accounts.mock.calls).toHaveLength(accountReads)
      configured = true
      clients.mockClear()
      accounts.mockClear()
      expect((await request(unavailableId)).status).toBe(409)
      expect((await request(wrongProviderId)).status).toBe(409)
      expect((await request(writerId, true)).status).toBe(409)
      memberContext = otherContext
      expect((await request(writerId)).status).toBe(409)
      expect(clients).not.toHaveBeenCalled()
      expect(accounts).not.toHaveBeenCalled()
      expect(defaults).not.toHaveBeenCalled()
      expect(requests).toHaveLength(1)

      memberContext = context
      defaultCredentialId = writerId
      expect((await request()).status).toBe(200)
      expect(defaults).toHaveBeenCalledWith({ organizationId: context.organization.id, orgMembershipId: context.currentMember.id, nativeProviderKey: "microsoft-365", teamIds: [teamId] })
      expect(requests[1]?.headers.get("authorization")).toBe("Bearer named-writer-token")
      defaultCredentialId = "microsoft-365"
      expect((await request()).status).toBe(200)
      expect(requests[2]?.headers.get("authorization")).toBe("Bearer legacy-token")
      defaultCredentialId = null
      expect((await request()).status).toBe(409)
      expect(requests).toHaveLength(3)
    } finally {
      teams.mockRestore()
      usable.mockRestore()
      defaults.mockRestore()
      clients.mockRestore()
      accounts.mockRestore()
    }
  })

  for (const mutation of mutationCases) {
    test(`${mutation.name} uses only the authenticated member and returns the exact provider receipt`, async () => {
      const context = organizationContext()
      const otherContext = organizationContext()
      const resolvedIds: Array<{ organizationId: string; orgMembershipId: string }> = []
      const requests: Request[] = []
      const graphFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        expect(request.url).toBe(`https://graph.example.test/v1.0/${mutation.graphPath}`)
        expect(request.method).toBe(mutation.method)
        expect(request.headers.get("authorization")).toBe("Bearer selected-member-token")
        expect(request.redirect).toBe("error")
        expect(request.signal).toBeDefined()
        expect(await request.text()).toBe(mutation.graphBody === null ? "" : JSON.stringify(mutation.graphBody))
        return mutation.graphResponse === null ? new Response(null, { status: mutation.graphStatus }) : Response.json(mutation.graphResponse, { status: mutation.graphStatus })
      }
      function makeApp(memberContext: OrganizationContext) {
        const app = new Hono<{ Variables: OrgRouteVariables }>()
        routes.registerMicrosoft365Routes(app, {
          graphBaseUrl: "https://graph.example.test/v1.0", fetch: graphFetch, memberRoute: contextMiddleware(memberContext),
          resolveAccessToken: async (input) => {
            resolvedIds.push(input)
            if (input.organizationId !== context.organization.id || input.orgMembershipId !== context.currentMember.id) {
              return { kind: "needs_connection", message: "This member has no connected account." }
            }
            return { kind: "ok", accessToken: "selected-member-token", scopes: [mutation.scope], enabledFeatures: [mutation.feature] }
          },
        })
        return app
      }
      const init = { method: mutation.method, headers: { "content-type": "application/json" }, body: JSON.stringify(mutation.body) }
      const response = await makeApp(context).request(`http://den-api.local/v1/capabilities/microsoft-365/${mutation.path}?orgMembershipId=${otherContext.currentMember.id}`, init)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject(mutation.receipt)
      expect(requests).toHaveLength(1)
      const denied = await makeApp(otherContext).request(`http://den-api.local/v1/capabilities/microsoft-365/${mutation.path}?orgMembershipId=${context.currentMember.id}`, init)
      expect(denied.status).toBe(409)
      expect(requests).toHaveLength(1)
      expect(resolvedIds).toEqual([
        { organizationId: context.organization.id, orgMembershipId: context.currentMember.id },
        { organizationId: otherContext.organization.id, orgMembershipId: otherContext.currentMember.id },
      ])
    })

    test(`${mutation.name} fails closed for missing, unknown, mismatched, or disabled grants`, async () => {
      const grants: Array<{ scopes: string[] | null; enabledFeatures: string[] }> = [
        { scopes: null, enabledFeatures: [mutation.feature] },
        { scopes: [], enabledFeatures: [mutation.feature] },
        { scopes: ["Unknown.Scope"], enabledFeatures: [mutation.feature] },
        { scopes: ["Mail.Read", "Calendars.Read", "Files.Read"], enabledFeatures: [mutation.feature] },
        { scopes: [mutation.feature === "mailSend" ? "Mail.ReadWrite" : "Mail.Send"], enabledFeatures: [mutation.feature] },
        { scopes: [mutation.scope], enabledFeatures: [] },
        { scopes: [mutation.scope], enabledFeatures: ["unknownFeature"] },
      ]
      let calls = 0
      for (const grant of grants) {
        const app = new Hono<{ Variables: OrgRouteVariables }>()
        routes.registerMicrosoft365Routes(app, {
          memberRoute: contextMiddleware(organizationContext()),
          fetch: async () => { calls += 1; throw new Error("Must not call Graph") },
          resolveAccessToken: async () => ({ kind: "ok", accessToken: "token", ...grant }),
        })
        const response = await app.request(`http://den-api.local/v1/capabilities/microsoft-365/${mutation.path}`, {
          method: mutation.method, headers: { "content-type": "application/json" }, body: JSON.stringify(mutation.body),
        })
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ error: "needs_connection" })
      }
      expect(calls).toBe(0)
    })

    test(`${mutation.name} rejects bodies over 1 MiB before JSON validation, including chunked bodies`, async () => {
      let calls = 0
      const app = new Hono<{ Variables: OrgRouteVariables }>()
      routes.registerMicrosoft365Routes(app, {
        memberRoute: contextMiddleware(organizationContext()),
        resolveAccessToken: async () => { calls += 1; throw new Error("Must not resolve credentials") },
        fetch: async () => { calls += 1; throw new Error("Must not call Graph") },
      })
      const bytes = new TextEncoder().encode(" ".repeat(1024 * 1024 + 1))
      for (const framing of ["content-length", "chunked", "unframed"]) {
        const headers = new Headers({ "content-type": "application/json" })
        if (framing === "content-length") headers.set("content-length", String(bytes.byteLength))
        if (framing === "chunked") headers.set("transfer-encoding", "chunked")
        let offset = 0
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset === bytes.byteLength) { controller.close(); return }
            const end = Math.min(offset + 64 * 1024, bytes.byteLength)
            controller.enqueue(bytes.slice(offset, end))
            offset = end
          },
        })
        const response = await app.request(`http://den-api.local/v1/capabilities/microsoft-365/${mutation.path}`, { method: mutation.method, headers, body })
        expect(response.status).toBe(413)
        expect(await response.json()).toMatchObject({ error: "invalid_request" })
      }
      expect(calls).toBe(0)
    })
  }

  test("advertises every mutation with discovery tags, bounded bodies, and receipt schemas", async () => {
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    const { registerGoogleWorkspaceRoutes } = await import("../src/routes/org/google-workspace.js")
    registerGoogleWorkspaceRoutes(app)
    routes.registerMicrosoft365Routes(app, {
      memberRoute: contextMiddleware(organizationContext()),
      resolveAccessToken: async () => { throw new Error("Discovery must not resolve credentials") },
      fetch: async () => { throw new Error("Discovery must not contact Graph") },
    })
    const spec = await generateSpecs(app)
    const catalog = buildMcpCatalog(spec)
    const mutationNames: string[] = []
    for (const mutation of mutationCases) {
      const path = `/v1/capabilities/microsoft-365/${mutation.path}`
        .replace(/draft_1|message_1/, "{messageId}").replace("event_1", "{eventId}").replace("item_1", "{itemId}")
      const pathItem = spec.paths[path]
      const operation = mutation.method === "POST" ? pathItem?.post : mutation.method === "PATCH" ? pathItem?.patch : pathItem?.delete
      expect(operation?.tags).toContain("Capability Sources")
      expect(operation?.requestBody).toBeDefined()
      expect(operation?.responses?.["200"]).toBeDefined()
      expect(operation?.description).toContain("Never automatically retry")
      const entry = catalog.find((entry) => entry.path === path && entry.method === mutation.method)
      expect(entry?.name).toBe(operation?.operationId)
      if (entry) mutationNames.push(entry.name)
    }
    expect(mutationNames.sort()).toEqual([
      "sendMicrosoft365MailDraft", "createMicrosoft365ReplyDraft", "updateMicrosoft365MailMessage", "moveMicrosoft365MailMessage",
      "updateMicrosoft365CalendarEvent", "cancelMicrosoft365CalendarEvent", "deleteMicrosoft365CalendarEvent",
      "updateMicrosoft365DriveItem", "createMicrosoft365DriveFolder",
    ].sort())
    expect(catalog.find((entry) => entry.path === "/v1/capabilities/microsoft-365/mail-messages")?.name).toBe("getCapabilitiesMicrosoft365MailMessages")
    for (const name of [
      "getCapabilitiesGoogleWorkspaceGmailMessages", "getCapabilitiesGoogleWorkspaceGmailMessage",
      "getCapabilitiesGoogleWorkspaceGmailAttachment", "getCapabilitiesGoogleWorkspaceCalendarEvents",
      "postCapabilitiesGoogleWorkspaceCalendarEvents", "patchCapabilitiesGoogleWorkspaceCalendarEvent",
      "getCapabilitiesGoogleWorkspaceDriveFiles", "getCapabilitiesGoogleWorkspaceDriveFile",
      "postCapabilitiesGoogleWorkspaceDriveFileShare", "postCapabilitiesGoogleWorkspaceGmailDrafts",
    ]) expect(catalog.some((entry) => entry.name === name)).toBe(true)
    const management = catalog.filter((entry) => /^(?:\w+Gmail|\w+Google(?:Calendar|Spreadsheet|Sheets|Drive)|\w+Microsoft365)/.test(entry.name) && !entry.name.includes("Capabilities"))
    expect(management).toHaveLength(32)
    for (const entry of management) {
      expect(entry.name).not.toContain("_")
      expect(`openwork-cloud_${entry.name}`.length).toBeLessThanOrEqual(64)
    }
    expect(spec.components.schemas?.Microsoft365MailSendBody).toMatchObject({ additionalProperties: false, required: ["confirmSend"] })
  })

  test("unauthenticated mutation requests never resolve credentials or call Graph", async () => {
    let calls = 0
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerMicrosoft365Routes(app, {
      memberRoute: async (c) => c.json({ error: "unauthorized" }, 401),
      resolveAccessToken: async () => { calls += 1; throw new Error("Must not resolve credentials") },
      fetch: async () => { calls += 1; throw new Error("Must not call Graph") },
    })
    for (const mutation of mutationCases) {
      const response = await app.request(`http://den-api.local/v1/capabilities/microsoft-365/${mutation.path}`, {
        method: mutation.method, headers: { "content-type": "application/json" }, body: JSON.stringify(mutation.body),
      })
      expect(response.status).toBe(401)
    }
    expect(calls).toBe(0)
  })

  test("unknown scopes fail closed on existing reads too", async () => {
    let calls = 0
    for (const scopes of [null, []]) {
      const app = new Hono<{ Variables: OrgRouteVariables }>()
      routes.registerMicrosoft365Routes(app, {
        memberRoute: contextMiddleware(organizationContext()),
        fetch: async () => { calls += 1; return Response.json({ value: [] }) },
        resolveAccessToken: async () => ({ kind: "ok", accessToken: "token", scopes, enabledFeatures: ["mailRead"] }),
      })
      expect((await app.request("http://den-api.local/v1/capabilities/microsoft-365/mail-messages")).status).toBe(409)
    }
    expect(calls).toBe(0)
  })

  test("draft permissions never grant sending or mail management", async () => {
    let calls = 0
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerMicrosoft365Routes(app, {
      memberRoute: contextMiddleware(organizationContext()),
      fetch: async () => { calls += 1; throw new Error("Must not call Graph") },
      resolveAccessToken: async () => ({ kind: "ok", accessToken: "token", scopes: ["Mail.ReadWrite", "Mail.Send"], enabledFeatures: ["mailDraft"] }),
    })
    for (const path of ["mail-drafts/draft_1/send", "mail-message/message_1/move"]) {
      const response = await app.request(`http://den-api.local/v1/capabilities/microsoft-365/${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(path.endsWith("send") ? { confirmSend: true } : { destination: "archive" }),
      })
      expect(response.status).toBe(409)
    }
    expect(calls).toBe(0)
  })

  test("rejects missing send confirmation, arbitrary fields, invalid bounds, paths, and partial reschedules before Graph", async () => {
    let calls = 0
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerMicrosoft365Routes(app, {
      memberRoute: contextMiddleware(organizationContext()),
      fetch: async () => { calls += 1; throw new Error("Must not call Graph") },
      resolveAccessToken: async () => { throw new Error("Invalid input should be rejected before resolving a token") },
    })
    const invalid: Array<{ method: string; path: string; body: unknown }> = [
      { method: "POST", path: "mail-drafts/draft_1/send", body: {} },
      { method: "POST", path: "mail-drafts/draft_1/send", body: { confirmSend: false } },
      { method: "POST", path: "mail-drafts/draft_1/send", body: { confirmSend: true, to: ["other@example.test"] } },
      { method: "POST", path: "mail-message/message_1/reply-draft", body: { comment: "x".repeat(20_001) } },
      { method: "PATCH", path: "mail-message/message_1", body: {} },
      { method: "PATCH", path: "mail-message/message_1", body: { isRead: "true" } },
      { method: "PATCH", path: "mail-message/message_1", body: { categories: Array(26).fill("Category") } },
      { method: "PATCH", path: "mail-message/message_1", body: { isRead: true, orgMembershipId: "other_member" } },
      { method: "POST", path: "mail-message/message_1/move", body: { destination: "https://evil.example.test" } },
      { method: "POST", path: "mail-message/message_1/move", body: { destination: "deleteditems" } },
      { method: "POST", path: "mail-message/message_1/move", body: { destination: "deleteditems", confirmTrash: false } },
      { method: "PATCH", path: "calendar-events/event_1", body: {} },
      { method: "PATCH", path: "calendar-events/event_1", body: { subject: "Update" } },
      { method: "PATCH", path: "calendar-events/event_1", body: { subject: "Update", confirmNotifications: false } },
      { method: "PATCH", path: "calendar-events/event_1", body: { confirmNotifications: true } },
      { method: "PATCH", path: "calendar-events/event_1", body: { start: "2026-09-10T10:00:00Z", confirmNotifications: true } },
      { method: "PATCH", path: "calendar-events/event_1", body: { start: "2026-09-10T11:00:00Z", end: "2026-09-10T10:00:00Z", confirmNotifications: true } },
      { method: "PATCH", path: "calendar-events/event_1", body: { subject: "Update", attendees: ["other@example.test"], confirmNotifications: true } },
      { method: "POST", path: "calendar-events/event_1/cancel", body: { comment: "Not confirmed" } },
      { method: "DELETE", path: "calendar-events/event_1", body: {} },
      { method: "PATCH", path: "drive-file/item_1", body: {} },
      { method: "PATCH", path: "drive-file/item_1", body: { name: "../bad" } },
      { method: "PATCH", path: "drive-file/item_1", body: { parentId: ".." } },
      { method: "PATCH", path: "drive-file/item_1", body: { parentId: "https://evil.example.test" } },
      { method: "PATCH", path: "drive-file/item_1", body: { name: "Plan", driveId: "other_drive" } },
      { method: "POST", path: "drive-folders", body: { name: "x".repeat(256), parentId: "folder_1" } },
      { method: "POST", path: "drive-folders", body: { name: "Plans", parentId: "folder_1", "@microsoft.graph.conflictBehavior": "replace" } },
    ]
    for (const request of invalid) {
      const response = await app.request(`http://den-api.local/v1/capabilities/microsoft-365/${request.path}`, {
        method: request.method, headers: { "content-type": "application/json" }, body: JSON.stringify(request.body),
      })
      expect(response.status).toBe(400)
    }
    expect(calls).toBe(0)
  })

  test("archive and inbox moves remain available without trash confirmation", async () => {
    const destinations: unknown[] = []
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerMicrosoft365Routes(app, {
      memberRoute: contextMiddleware(organizationContext()),
      resolveAccessToken: async () => ({ kind: "ok", accessToken: "token", scopes: ["Mail.ReadWrite"], enabledFeatures: ["mailManage"] }),
      fetch: async (input, init) => {
        const request = new Request(input, init)
        destinations.push(await request.json())
        return Response.json({ id: "moved_1" }, { status: 201 })
      },
    })
    for (const destination of ["archive", "inbox"]) {
      const response = await app.request("http://den-api.local/v1/capabilities/microsoft-365/mail-message/message_1/move", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ destination }),
      })
      expect(response.status).toBe(200)
    }
    expect(destinations).toEqual([{ destinationId: "archive" }, { destinationId: "inbox" }])
  })

  test("ambiguous send returns unknown outcome and never issues a duplicate request", async () => {
    let calls = 0
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerMicrosoft365Routes(app, {
      memberRoute: contextMiddleware(organizationContext()),
      resolveAccessToken: async () => ({ kind: "ok", accessToken: "token", scopes: ["Mail.Send"], enabledFeatures: ["mailSend"] }),
      fetch: async () => { calls += 1; throw new TypeError("Send response lost") },
    })
    const response = await app.request("http://den-api.local/v1/capabilities/microsoft-365/mail-drafts/draft_1/send", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmSend: true }),
    })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: "microsoft_graph_error", outcome: "unknown", retryable: false })
    expect(calls).toBe(1)
  })
})

describe("Microsoft 365 injected routes", () => {
  test("maps Graph mail for the calling member and blocks disconnected or under-scoped accounts", async () => {
    const context = organizationContext()
    const resolvedIds: Array<{ organizationId: string; orgMembershipId: string }> = []
    let graphCalls = 0
    const graphFetch: typeof fetch = async (input, init) => {
      graphCalls += 1
      const request = new Request(input, init)
      expect(request.headers.get("authorization")).toBe("Bearer delegated-member-token")
      expect(new URL(request.url).pathname).toBe("/graph/v1.0/me/messages")
      return Response.json({
        value: [{
          id: "message_1",
          subject: "Launch readiness",
          receivedDateTime: "2026-07-09T16:00:00Z",
          bodyPreview: "The checklist is complete.",
          from: { emailAddress: { name: "Ada", address: "ada@example.test" } },
          webLink: "https://outlook.office.test/mail/message_1",
        }],
      })
    }

    const successApp = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerMicrosoft365Routes(successApp, {
      graphBaseUrl: "https://graph.example.test/graph/v1.0",
      fetch: graphFetch,
      memberRoute: contextMiddleware(context),
      resolveAccessToken: async (input) => {
        resolvedIds.push(input)
        return {
          kind: "ok",
          accessToken: "delegated-member-token",
          scopes: ["Mail.Read", "Calendars.Read", "Files.Read"],
          enabledFeatures: ["mailRead", "calendarRead", "filesRead"],
        }
      },
    })
    const successResponse = await successApp.request("http://den-api.local/v1/capabilities/microsoft-365/mail-messages?maxResults=3")
    expect(successResponse.status).toBe(200)
    expect(await successResponse.json()).toEqual({
      ok: true,
      messages: [{
        id: "message_1",
        conversationId: "",
        subject: "Launch readiness",
        receivedDateTime: "2026-07-09T16:00:00Z",
        preview: "The checklist is complete.",
        from: { name: "Ada", address: "ada@example.test" },
        to: [],
        webLink: "https://outlook.office.test/mail/message_1",
        hasAttachments: false,
      }],
    })
    expect(resolvedIds).toEqual([{
      organizationId: context.organization.id,
      orgMembershipId: context.currentMember.id,
    }])
    expect(graphCalls).toBe(1)

    const missingScopeApp = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerMicrosoft365Routes(missingScopeApp, {
      fetch: graphFetch,
      memberRoute: contextMiddleware(context),
      resolveAccessToken: async () => ({
        kind: "ok",
        accessToken: "token",
        scopes: ["Files.Read"],
        enabledFeatures: ["mailRead", "filesRead"],
      }),
    })
    const missingScopeResponse = await missingScopeApp.request("http://den-api.local/v1/capabilities/microsoft-365/mail-messages")
    expect(missingScopeResponse.status).toBe(409)
    expect(await missingScopeResponse.json()).toEqual({
      error: "needs_connection",
      message: "Your connected Microsoft account is missing the Outlook mail read permission. An admin can enable it on the Microsoft 365 connector in OpenWork Cloud -> Connectors; then reconnect your account.",
    })
    expect(graphCalls).toBe(1)

    const disabledFeatureApp = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerMicrosoft365Routes(disabledFeatureApp, {
      fetch: graphFetch,
      memberRoute: contextMiddleware(context),
      resolveAccessToken: async () => ({
        kind: "ok",
        accessToken: "old-token-with-mail-scope",
        scopes: ["Mail.Read", "Files.Read"],
        enabledFeatures: ["filesRead"],
      }),
    })
    const disabledFeatureResponse = await disabledFeatureApp.request("http://den-api.local/v1/capabilities/microsoft-365/mail-messages")
    expect(disabledFeatureResponse.status).toBe(409)
    expect(await disabledFeatureResponse.json()).toEqual({
      error: "needs_connection",
      message: "The workspace administrator has disabled Outlook mail access for the Microsoft 365 connection.",
    })
    expect(graphCalls).toBe(1)

    const disconnectedApp = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerMicrosoft365Routes(disconnectedApp, {
      fetch: graphFetch,
      memberRoute: contextMiddleware(context),
      resolveAccessToken: async () => ({ kind: "needs_connection", message: "Connect Microsoft 365 first." }),
    })
    const disconnectedResponse = await disconnectedApp.request("http://den-api.local/v1/capabilities/microsoft-365/calendar-events?timeMin=2026-07-09T00%3A00%3A00Z&timeMax=2026-07-12T00%3A00%3A00Z")
    expect(disconnectedResponse.status).toBe(409)
    expect(await disconnectedResponse.json()).toEqual({ error: "needs_connection", message: "Connect Microsoft 365 first." })
    expect(graphCalls).toBe(1)
  })

  test("executes enabled write and Teams capabilities with the member's delegated scopes", async () => {
    const context = organizationContext()
    const requests: Request[] = []
    const graphFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      const url = new URL(request.url)
      if (url.pathname.endsWith("/me/messages")) {
        return Response.json({ id: "draft_1", subject: "Follow up", body: { contentType: "text", content: "Hello" } }, { status: 201 })
      }
      if (url.pathname.endsWith("/me/events")) {
        return Response.json({
          id: "event_1",
          subject: "Review",
          start: { dateTime: "2026-07-13T10:00:00Z", timeZone: "UTC" },
          end: { dateTime: "2026-07-13T10:30:00Z", timeZone: "UTC" },
        }, { status: 201 })
      }
      if (decodeURIComponent(url.pathname).endsWith("/me/drive/root:/OpenWork/notes.txt:/content")) {
        return Response.json({ id: "file_1", name: "notes.txt", file: { mimeType: "text/plain" } }, { status: 201 })
      }
      if (url.pathname.endsWith("/me/chats")) {
        return Response.json({ value: [{ id: "chat_1", topic: "Launch", chatType: "group" }] })
      }
      if (url.pathname.endsWith("/chats/chat_1/messages") && request.method === "GET") {
        return Response.json({ value: [{ id: "message_1", body: { content: "Ready" } }] })
      }
      if (url.pathname.endsWith("/chats/chat_1/messages") && request.method === "POST") {
        return Response.json({ id: "message_2", body: { content: "Ship it" } }, { status: 201 })
      }
      return new Response("not found", { status: 404 })
    }

    const app = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerMicrosoft365Routes(app, {
      graphBaseUrl: "https://graph.example.test/v1.0",
      fetch: graphFetch,
      memberRoute: contextMiddleware(context),
      resolveAccessToken: async () => ({
        kind: "ok",
        accessToken: "delegated-member-token",
        scopes: ["Mail.ReadWrite", "Calendars.ReadWrite", "Files.ReadWrite.All", "Chat.Read", "ChatMessage.Send"],
        enabledFeatures: ["mailDraft", "calendarWrite", "filesFull", "teamsChatSend"],
      }),
    })

    const draftResponse = await app.request("http://den-api.local/v1/capabilities/microsoft-365/mail-drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: ["ada@example.test"], subject: "Follow up", body: "Hello" }),
    })
    expect(draftResponse.status).toBe(200)
    expect(await draftResponse.json()).toMatchObject({ draft: { id: "draft_1" } })

    const eventResponse = await app.request("http://den-api.local/v1/capabilities/microsoft-365/calendar-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subject: "Review",
        start: "2026-07-13T10:00:00.000Z",
        end: "2026-07-13T10:30:00.000Z",
        timeZone: "UTC",
      }),
    })
    expect(eventResponse.status).toBe(200)
    expect(await eventResponse.json()).toMatchObject({ event: { id: "event_1" } })

    const fileResponse = await app.request("http://den-api.local/v1/capabilities/microsoft-365/drive-files", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "OpenWork/notes.txt", content: "Notes" }),
    })
    expect(fileResponse.status).toBe(200)
    expect(await fileResponse.json()).toMatchObject({ file: { id: "file_1" } })

    const chatsResponse = await app.request("http://den-api.local/v1/capabilities/microsoft-365/teams-chats?maxResults=5")
    expect(chatsResponse.status).toBe(200)
    expect(await chatsResponse.json()).toMatchObject({ chats: [{ id: "chat_1" }] })

    const messagesResponse = await app.request("http://den-api.local/v1/capabilities/microsoft-365/teams-chats/chat_1/messages?maxResults=5")
    expect(messagesResponse.status).toBe(200)
    expect(await messagesResponse.json()).toMatchObject({ messages: [{ id: "message_1" }] })

    const sendResponse = await app.request("http://den-api.local/v1/capabilities/microsoft-365/teams-chats/chat_1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Ship it" }),
    })
    expect(sendResponse.status).toBe(200)
    expect(await sendResponse.json()).toMatchObject({ message: { id: "message_2" } })
    expect(requests.map((request) => request.method)).toEqual(["POST", "POST", "PUT", "GET", "GET", "POST"])
  })

  test("accepts stronger scopes for enabled reads but rejects writes without their feature or grant", async () => {
    const context = organizationContext()
    let graphCalls = 0
    const graphFetch: typeof fetch = async () => {
      graphCalls += 1
      return Response.json({ value: [{ id: "message_1" }] })
    }
    const strongerReadApp = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerMicrosoft365Routes(strongerReadApp, {
      fetch: graphFetch,
      memberRoute: contextMiddleware(context),
      resolveAccessToken: async () => ({
        kind: "ok",
        accessToken: "token",
        scopes: ["Mail.ReadWrite"],
        enabledFeatures: ["mailRead"],
      }),
    })
    expect((await strongerReadApp.request("http://den-api.local/v1/capabilities/microsoft-365/mail-messages")).status).toBe(200)

    const missingWriteGrantApp = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerMicrosoft365Routes(missingWriteGrantApp, {
      fetch: graphFetch,
      memberRoute: contextMiddleware(context),
      resolveAccessToken: async () => ({
        kind: "ok",
        accessToken: "token",
        scopes: ["Mail.Read"],
        enabledFeatures: ["mailDraft"],
      }),
    })
    const denied = await missingWriteGrantApp.request("http://den-api.local/v1/capabilities/microsoft-365/mail-drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: ["ada@example.test"], subject: "Draft", body: "Body" }),
    })
    expect(denied.status).toBe(409)
    expect(await denied.json()).toEqual({
      error: "needs_connection",
      message: "Your connected Microsoft account is missing the Outlook mail read/write permission. An admin can enable it on the Microsoft 365 connector in OpenWork Cloud -> Connectors; then reconnect your account.",
    })
    expect(graphCalls).toBe(1)
  })

  test("returns OneDrive binary file bytes as byte-exact base64", async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xfb, 0xef, 0xbe, 0xff])
    const graphFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const pathname = new URL(request.url).pathname
      if (pathname.endsWith("/content")) {
        return new Response(binary, { headers: { "content-type": "application/octet-stream" } })
      }
      return Response.json({
        id: "binary_1",
        name: "image.png",
        size: binary.byteLength,
        file: { mimeType: "application/octet-stream" },
      })
    }

    const response = await driveFileApp(graphFetch).request("http://den-api.local/v1/capabilities/microsoft-365/drive-file/binary_1")
    expect(response.status).toBe(200)
    const payload: unknown = await response.json()
    expect(payload).toMatchObject({
      ok: true,
      file: {
        encoding: "base64",
        content: null,
        contentUnavailableReason: null,
      },
    })
    if (!isRecord(payload) || !isRecord(payload.file) || typeof payload.file.contentBase64 !== "string") {
      throw new Error("Expected a base64-encoded file response.")
    }
    expect(Buffer.compare(Buffer.from(payload.file.contentBase64, "base64"), binary)).toBe(0)
  })

  test("returns OneDrive text files with text encoding", async () => {
    const content = "OneDrive text remains readable."
    const graphFetch: typeof fetch = async (input, init) => {
      const pathname = new URL(new Request(input, init).url).pathname
      if (pathname.endsWith("/content")) {
        return new Response(content, { headers: { "content-type": "text/plain; charset=utf-8" } })
      }
      return Response.json({ id: "text_1", name: "notes.txt", size: content.length, file: { mimeType: "text/plain" } })
    }

    const response = await driveFileApp(graphFetch).request("http://den-api.local/v1/capabilities/microsoft-365/drive-file/text_1")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      file: {
        content,
        contentBase64: null,
        encoding: "text",
        truncated: false,
        contentUnavailableReason: null,
      },
    })
  })

  test("returns strict UTF-8 text even when the OneDrive MIME type looks binary", async () => {
    const content = "0\nSECTION\n2\nENTITIES\n0\nEOF\n"
    const graphFetch: typeof fetch = async (input, init) => {
      const pathname = new URL(new Request(input, init).url).pathname
      if (pathname.endsWith("/content")) {
        return new Response(content, { headers: { "content-type": "image/vnd.dxf" } })
      }
      return Response.json({ id: "drawing_1", name: "drawing.dxf", size: content.length, file: { mimeType: "image/vnd.dxf" } })
    }

    const response = await driveFileApp(graphFetch).request("http://den-api.local/v1/capabilities/microsoft-365/drive-file/drawing_1")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      file: { content, contentBase64: null, encoding: "text", contentUnavailableReason: null },
    })
  })

  test("returns folder metadata with no content encoding", async () => {
    const graphFetch: typeof fetch = async () => Response.json({ id: "folder_1", name: "Projects", size: 0, folder: {} })

    const response = await driveFileApp(graphFetch).request("http://den-api.local/v1/capabilities/microsoft-365/drive-file/folder_1")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      file: {
        content: null,
        contentBase64: null,
        encoding: "none",
        contentUnavailableReason: "folder",
      },
    })
  })

  test("rejects oversized OneDrive metadata without downloading content", async () => {
    let contentCalls = 0
    const graphFetch: typeof fetch = async (input, init) => {
      const pathname = new URL(new Request(input, init).url).pathname
      if (pathname.endsWith("/content")) {
        contentCalls += 1
        return new Response("unexpected")
      }
      return Response.json({
        id: "oversized_1",
        name: "archive.bin",
        size: 10 * 1024 * 1024 + 1,
        file: { mimeType: "application/octet-stream" },
      })
    }

    const response = await driveFileApp(graphFetch).request("http://den-api.local/v1/capabilities/microsoft-365/drive-file/oversized_1")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      file: {
        content: null,
        contentBase64: null,
        encoding: "none",
        contentUnavailableReason: "file_too_large",
      },
    })
    expect(contentCalls).toBe(0)
  })
})
