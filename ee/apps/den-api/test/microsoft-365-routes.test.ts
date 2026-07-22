import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, test } from "bun:test"
import { Hono, type MiddlewareHandler } from "hono"
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
})
