import { describe, expect, test } from "bun:test"
import {
  encodeOneDrivePath,
  escapeOneDriveSearchPath,
  extractMicrosoftCalendarEvent,
  extractMicrosoftCalendarEvents,
  extractMicrosoftDriveItems,
  extractMicrosoftMailMessage,
  extractMicrosoftMailMessages,
  extractMicrosoftTeamsChats,
  extractMicrosoftTeamsMessages,
  MicrosoftGraphClient,
  MicrosoftGraphRequestError,
} from "../src/capability-sources/microsoft-graph.js"

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

describe("Microsoft Graph response mapping", () => {
  test("maps Outlook message summaries and full message bodies", () => {
    const payload = {
      id: "message_1",
      conversationId: "conversation_1",
      subject: "Quarterly plan",
      receivedDateTime: "2026-07-09T15:00:00Z",
      bodyPreview: "The Q3 plan is ready.",
      body: { contentType: "text", content: "Full message body" },
      from: { emailAddress: { name: "Ada", address: "ada@example.com" } },
      toRecipients: [{ emailAddress: { name: "Ben", address: "ben@example.com" } }],
      ccRecipients: [{ emailAddress: { name: "Grace", address: "grace@example.com" } }],
      webLink: "https://outlook.office.com/mail/message_1",
      hasAttachments: true,
    }

    expect(extractMicrosoftMailMessages({ value: [payload] })).toEqual([{
      id: "message_1",
      conversationId: "conversation_1",
      subject: "Quarterly plan",
      receivedDateTime: "2026-07-09T15:00:00Z",
      preview: "The Q3 plan is ready.",
      from: { name: "Ada", address: "ada@example.com" },
      to: [{ name: "Ben", address: "ben@example.com" }],
      webLink: "https://outlook.office.com/mail/message_1",
      hasAttachments: true,
    }])
    expect(extractMicrosoftMailMessage(payload).body).toBe("Full message body")
    expect(extractMicrosoftMailMessage(payload).bodyTruncated).toBe(false)
    expect(extractMicrosoftMailMessage(payload).cc).toEqual([{ name: "Grace", address: "grace@example.com" }])
  })

  test("maps calendar timezone, participants, source link, and Teams link", () => {
    expect(extractMicrosoftCalendarEvents({
      value: [{
        id: "event_1",
        subject: "Launch review",
        bodyPreview: "Review launch status",
        start: { dateTime: "2026-07-10T09:00:00", timeZone: "America/Los_Angeles" },
        end: { dateTime: "2026-07-10T09:30:00", timeZone: "America/Los_Angeles" },
        isAllDay: false,
        location: { displayName: "OpenWork Room" },
        organizer: { emailAddress: { name: "Ada", address: "ada@example.com" } },
        attendees: [{ emailAddress: { name: "Ben", address: "ben@example.com" } }],
        webLink: "https://outlook.office.com/calendar/event_1",
        onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/example" },
      }],
    })).toEqual([{
      id: "event_1",
      subject: "Launch review",
      preview: "Review launch status",
      start: "2026-07-10T09:00:00",
      startTimeZone: "America/Los_Angeles",
      end: "2026-07-10T09:30:00",
      endTimeZone: "America/Los_Angeles",
      isAllDay: false,
      location: "OpenWork Room",
      organizer: { name: "Ada", address: "ada@example.com" },
      attendees: [{ name: "Ben", address: "ben@example.com" }],
      webLink: "https://outlook.office.com/calendar/event_1",
      onlineMeetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
    }])
  })

  test("maps OneDrive file and folder metadata", () => {
    expect(extractMicrosoftDriveItems({ value: [
      {
        id: "file_1",
        name: "Q3 Plan.txt",
        size: 128,
        lastModifiedDateTime: "2026-07-09T13:00:00Z",
        webUrl: "https://onedrive.live.com/file_1",
        file: { mimeType: "text/plain" },
      },
      { id: "folder_1", name: "Plans", folder: { childCount: 2 } },
    ] })).toEqual([
      {
        id: "file_1",
        name: "Q3 Plan.txt",
        size: 128,
        modifiedTime: "2026-07-09T13:00:00Z",
        webUrl: "https://onedrive.live.com/file_1",
        mimeType: "text/plain",
        kind: "file",
      },
      {
        id: "folder_1",
        name: "Plans",
        size: null,
        modifiedTime: "",
        webUrl: "",
        mimeType: "",
        kind: "folder",
      },
    ])
  })

  test("maps created calendar events and Teams chats/messages", () => {
    expect(extractMicrosoftCalendarEvent({
      id: "event_created",
      subject: "Permission parity",
      start: { dateTime: "2026-07-13T10:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-07-13T10:30:00", timeZone: "UTC" },
    }).id).toBe("event_created")
    expect(extractMicrosoftTeamsChats({ value: [{ id: "chat_1", topic: "Launch", chatType: "group" }] })).toEqual([{
      id: "chat_1",
      topic: "Launch",
      chatType: "group",
      webUrl: "",
      lastUpdatedDateTime: "",
    }])
    expect(extractMicrosoftTeamsMessages({ value: [{
      id: "teams_message_1",
      createdDateTime: "2026-07-13T10:00:00Z",
      body: { content: "Ready" },
      from: { user: { displayName: "Ada", id: "user_1" } },
    }] })).toEqual([{
      id: "teams_message_1",
      createdDateTime: "2026-07-13T10:00:00Z",
      content: "Ready",
      from: { name: "Ada", address: "user_1" },
      webUrl: "",
    }])
  })
})

describe("MicrosoftGraphClient", () => {
  test("uses bearer auth and configurable endpoints for mail, calendar, and OneDrive", async () => {
    const requests: Request[] = []
    const fetchMock: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      const url = new URL(request.url)
      if (url.pathname === "/graph/v1.0/me/messages") {
        return json({ value: [{ id: "message_1", subject: "Launch" }] })
      }
      if (url.pathname === "/graph/v1.0/me/calendarView") {
        return json({ value: [{ id: "event_1", subject: "Review" }] })
      }
      if (decodeURIComponent(url.pathname) === "/graph/v1.0/me/drive/root/search(q='Q3 plan')") {
        return json({ value: [{ id: "file_1", name: "Q3 Plan.txt", file: { mimeType: "text/plain" } }] })
      }
      if (url.pathname === "/graph/v1.0/me/drive/items/file_1") {
        return json({ id: "file_1", name: "Q3 Plan.txt", size: 50, file: { mimeType: "text/plain" } })
      }
      if (url.pathname === "/graph/v1.0/me/drive/items/file_1/content") {
        return new Response("Q3 Plan\nShip cloud connections.", { headers: { "content-type": "text/plain" } })
      }
      return new Response("not found", { status: 404 })
    }
    const client = new MicrosoftGraphClient({
      accessToken: "member-token",
      baseUrl: "https://graph.example.test/graph/v1.0",
      fetch: fetchMock,
    })

    await client.listMailMessages({ search: "launch", maxResults: 3 })
    await client.listCalendarEvents({ start: "2026-07-09T00:00:00Z", end: "2026-07-12T00:00:00Z", maxResults: 10 })
    await client.searchDriveItems({ query: "Q3 plan", maxResults: 5 })
    const file = await client.getDriveItemWithContent("file_1")

    expect(requests.every((request) => request.headers.get("authorization") === "Bearer member-token")).toBe(true)
    const mailUrl = new URL(requests[0]?.url ?? "")
    expect(mailUrl.searchParams.get("$search")).toBe('"launch"')
    expect(mailUrl.searchParams.get("$top")).toBe("3")
    expect(requests[0]?.headers.get("ConsistencyLevel")).toBe("eventual")
    const calendarUrl = new URL(requests[1]?.url ?? "")
    expect(calendarUrl.searchParams.get("startDateTime")).toBe("2026-07-09T00:00:00Z")
    expect(file.content).toBe("Q3 Plan\nShip cloud connections.")
    expect(file.contentUnavailableReason).toBeNull()
  })

  test("does not download oversized or binary OneDrive files", async () => {
    let contentRequests = 0
    const fetchMock: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname.endsWith("/large")) {
        return json({ id: "large", name: "Large.txt", size: 6_000_000, file: { mimeType: "text/plain" } })
      }
      if (url.pathname.endsWith("/binary")) {
        return json({ id: "binary", name: "Plan.docx", size: 2_000, file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } })
      }
      contentRequests += 1
      return new Response("unexpected")
    }
    const client = new MicrosoftGraphClient({ accessToken: "token", fetch: fetchMock })

    expect((await client.getDriveItemWithContent("large")).contentUnavailableReason).toBe("file_too_large")
    expect((await client.getDriveItemWithContent("binary")).contentUnavailableReason).toBe("unsupported_content_type")
    expect(contentRequests).toBe(0)
  })

  test("creates drafts and events, writes OneDrive text, and reads/sends Teams chat", async () => {
    const requests: Request[] = []
    const fetchMock: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      const url = new URL(request.url)
      if (url.pathname.endsWith("/me/messages") && request.method === "POST") {
        return json({ id: "draft_1", subject: "Draft", body: { contentType: "text", content: "Body" } }, 201)
      }
      if (url.pathname.endsWith("/me/events") && request.method === "POST") {
        return json({
          id: "event_1",
          subject: "Review",
          start: { dateTime: "2026-07-13T10:00:00Z", timeZone: "UTC" },
          end: { dateTime: "2026-07-13T10:30:00Z", timeZone: "UTC" },
        }, 201)
      }
      if (decodeURIComponent(url.pathname).endsWith("/me/drive/root:/OpenWork/Review notes.txt:/content")) {
        return json({ id: "file_1", name: "Review notes.txt", file: { mimeType: "text/plain" } }, 201)
      }
      if (url.pathname.endsWith("/me/chats")) {
        return json({ value: [{ id: "chat_1", topic: "Launch", chatType: "group" }] })
      }
      if (url.pathname.endsWith("/chats/chat_1/messages") && request.method === "GET") {
        return json({ value: [{ id: "message_1", body: { content: "Ready" } }] })
      }
      if (url.pathname.endsWith("/chats/chat_1/messages") && request.method === "POST") {
        return json({ id: "message_2", body: { content: "Ship it" } }, 201)
      }
      return new Response("not found", { status: 404 })
    }
    const client = new MicrosoftGraphClient({
      accessToken: "member-token",
      baseUrl: "https://graph.example.test/v1.0",
      fetch: fetchMock,
    })

    expect((await client.createMailDraft({ to: ["ada@example.test"], subject: "Draft", body: "Body" })).id).toBe("draft_1")
    expect((await client.createCalendarEvent({
      subject: "Review",
      start: "2026-07-13T10:00:00Z",
      end: "2026-07-13T10:30:00Z",
      timeZone: "UTC",
    })).id).toBe("event_1")
    expect((await client.putDriveTextFile({ path: "OpenWork/Review notes.txt", content: "Notes" })).id).toBe("file_1")
    expect((await client.listTeamsChats(10))[0]?.id).toBe("chat_1")
    expect((await client.listTeamsMessages("chat_1", 10))[0]?.id).toBe("message_1")
    expect((await client.sendTeamsMessage("chat_1", "Ship it")).id).toBe("message_2")

    expect(requests.every((request) => request.headers.get("authorization") === "Bearer member-token")).toBe(true)
    expect(requests.map((request) => request.method)).toEqual(["POST", "POST", "PUT", "GET", "GET", "POST"])
    expect(await requests[0]?.clone().json()).toMatchObject({
      subject: "Draft",
      toRecipients: [{ emailAddress: { address: "ada@example.test" } }],
    })
    expect(await requests[5]?.clone().json()).toEqual({ body: { contentType: "text", content: "Ship it" } })
  })

  test("bounds streamed text when Graph omits size headers", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname.endsWith("/streamed")) {
        return json({ id: "streamed", name: "Streamed.txt", file: { mimeType: "text/plain" } })
      }
      return new Response("123456789", { headers: { "content-type": "text/plain" } })
    }
    const client = new MicrosoftGraphClient({ accessToken: "token", fetch: fetchMock, maxDownloadBytes: 5 })

    const file = await client.getDriveItemWithContent("streamed")
    expect(file.content).toBeNull()
    expect(file.contentUnavailableReason).toBe("file_too_large")
  })

  test("bounds chunked Graph JSON and full mail body output", async () => {
    const oversizedJsonFetch: typeof fetch = async () => new Response(JSON.stringify({
      id: "message_oversized",
      body: { contentType: "text", content: "x".repeat(500) },
    }), { headers: { "content-type": "application/json" } })
    const boundedResponseClient = new MicrosoftGraphClient({
      accessToken: "token",
      fetch: oversizedJsonFetch,
      maxJsonResponseBytes: 100,
    })
    await expect(boundedResponseClient.getMailMessage("message_oversized")).rejects.toBeInstanceOf(MicrosoftGraphRequestError)

    const bodyFetch: typeof fetch = async () => json({
      id: "message_body",
      body: { contentType: "text", content: "abcdef" },
    })
    const boundedBodyClient = new MicrosoftGraphClient({
      accessToken: "token",
      fetch: bodyFetch,
      maxContentCharacters: 3,
    })
    const message = await boundedBodyClient.getMailMessage("message_body")
    expect(message.body).toBe("abc")
    expect(message.bodyTruncated).toBe(true)
  })

  test("turns Graph failures into bounded typed errors", async () => {
    const fetchMock: typeof fetch = async () => new Response("x".repeat(500), { status: 503 })
    const client = new MicrosoftGraphClient({ accessToken: "token", fetch: fetchMock })

    try {
      await client.listMailMessages({ maxResults: 3 })
      throw new Error("Expected MicrosoftGraphRequestError")
    } catch (error) {
      expect(error).toBeInstanceOf(MicrosoftGraphRequestError)
      expect(error instanceof Error ? error.message.length : 0).toBeLessThan(400)
    }
  })
})

test("OneDrive path search escapes OData apostrophes", () => {
  expect(escapeOneDriveSearchPath("Q3's plan")).toBe("Q3''s plan")
  expect(encodeOneDrivePath("OpenWork/Review notes.txt")).toBe("OpenWork/Review%20notes.txt")
})
