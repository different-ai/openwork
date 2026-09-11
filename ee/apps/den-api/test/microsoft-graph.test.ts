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
  MicrosoftGraphMutationOutcomeUnknownError,
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

  test("does not download oversized OneDrive files and preserves supported binary bytes", async () => {
    let contentRequests = 0
    const fetchMock: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname.endsWith("/large")) {
        return json({ id: "large", name: "Large.txt", size: 10 * 1024 * 1024 + 1, file: { mimeType: "text/plain" } })
      }
      if (url.pathname.endsWith("/binary")) {
        return json({ id: "binary", name: "Plan.docx", size: 2_000, file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } })
      }
      contentRequests += 1
      return new Response(new Uint8Array([0xff, 0x00, 0xab]))
    }
    const client = new MicrosoftGraphClient({ accessToken: "token", fetch: fetchMock })

    expect((await client.getDriveItemWithContent("large")).contentUnavailableReason).toBe("file_too_large")
    expect(contentRequests).toBe(0)
    expect(await client.getDriveItemWithContent("binary")).toMatchObject({ encoding: "base64", contentBase64: "/wCr", contentUnavailableReason: null })
    expect(contentRequests).toBe(1)
  })

  test("sends exactly one existing draft and reports Graph 202 as accepted, not delivered", async () => {
    const requests: Request[] = []
    const client = new MicrosoftGraphClient({
      accessToken: "member-token",
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        expect(request.url).toBe("https://graph.microsoft.com/v1.0/me/messages/draft%2B1%3D/send")
        expect(request.method).toBe("POST")
        expect(request.redirect).toBe("error")
        expect(request.headers.get("authorization")).toBe("Bearer member-token")
        expect(await request.text()).toBe("")
        return new Response(null, { status: 202 })
      },
    })
    expect(await client.sendMailDraft("draft+1=")).toEqual({ draftId: "draft+1=", status: "accepted" })
    expect(requests).toHaveLength(1)
  })

  test("never replays ambiguous sends, server failures, or unexpected successful statuses", async () => {
    const failures: Array<() => Promise<Response>> = [
      async () => { throw new TypeError("response lost after send") },
      async () => new Response(null, { status: 503 }),
      async () => new Response(null, { status: 204 }),
      async () => json({ delivered: true }, 200),
    ]
    for (const failure of failures) {
      let calls = 0
      const client = new MicrosoftGraphClient({ accessToken: "member-token", fetch: async () => { calls += 1; return failure() } })
      await expect(client.sendMailDraft("draft_1")).rejects.toBeInstanceOf(MicrosoftGraphMutationOutcomeUnknownError)
      expect(calls).toBe(1)
    }
  })

  test("propagates bounded provider rejections without retrying or claiming acceptance", async () => {
    let calls = 0
    const client = new MicrosoftGraphClient({ accessToken: "member-token", maxJsonResponseBytes: 40, fetch: async () => {
      calls += 1
      return new Response("denied".repeat(100), { status: 403 })
    } })
    await expect(client.sendMailDraft("draft_1")).rejects.toMatchObject({ status: 403, name: "MicrosoftGraphRequestError" })
    expect(calls).toBe(1)
  })

  test("preserves cancellation and timeout bounds without retrying a send", async () => {
    const controller = new AbortController()
    let calls = 0
    const client = new MicrosoftGraphClient({
      accessToken: "member-token", signal: controller.signal, timeoutMs: 20,
      fetch: async (_input, init) => {
        calls += 1
        const signal = init?.signal
        if (!signal) throw new Error("Expected an abort signal")
        controller.abort()
        signal.throwIfAborted()
        throw new Error("Must abort before returning")
      },
    })
    await expect(client.sendMailDraft("draft_1")).rejects.toBeInstanceOf(MicrosoftGraphMutationOutcomeUnknownError)
    expect(calls).toBe(1)
  })

  test("creates a reply draft and patches only selected mail state, preserving move receipts", async () => {
    const requests: Request[] = []
    const client = new MicrosoftGraphClient({ accessToken: "member-token", fetch: async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.url.endsWith("/createReply")) return json({ id: "reply_1", isDraft: true, conversationId: "thread_1", body: { content: "Reply" } }, 201)
      if (request.url.endsWith("/move")) return json({ id: "moved_1", parentFolderId: "archive_1", isRead: true }, 201)
      return json({ id: "message_1", isRead: false, categories: ["Follow up"] })
    } })
    expect(await client.createMailReplyDraft("message_1", "Reply")).toMatchObject({ id: "reply_1", isDraft: true, conversationId: "thread_1" })
    expect(await client.updateMailMessage("message_1", { isRead: false, categories: ["Follow up"] })).toMatchObject({ isRead: false, categories: ["Follow up"] })
    expect(await client.moveMailMessage("message_1", "archive")).toMatchObject({ id: "moved_1", parentFolderId: "archive_1" })
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["POST", "/v1.0/me/messages/message_1/createReply"],
      ["PATCH", "/v1.0/me/messages/message_1"],
      ["POST", "/v1.0/me/messages/message_1/move"],
    ])
    expect(await requests[0]?.json()).toEqual({ comment: "Reply" })
    expect(await requests[1]?.json()).toEqual({ isRead: false, categories: ["Follow up"] })
    expect(await requests[2]?.json()).toEqual({ destinationId: "archive" })
  })

  test("patches paired UTC event times without erasing omitted fields and handles empty cancellation/deletion receipts", async () => {
    const requests: Request[] = []
    const client = new MicrosoftGraphClient({ accessToken: "member-token", fetch: async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      if (request.url.endsWith("/cancel")) return new Response(null, { status: 202 })
      return json({ id: "event_1", subject: "Updated" })
    } })
    expect((await client.updateCalendarEvent("event_1", { subject: "Updated" })).id).toBe("event_1")
    await client.updateCalendarEvent("event_1", { start: "2026-09-10T10:00:00Z", end: "2026-09-10T11:00:00Z", location: "" })
    expect(await client.cancelCalendarEvent("event_1", "Cancelled by organizer")).toEqual({ eventId: "event_1", status: "accepted" })
    expect(await client.deleteCalendarEvent("event_1")).toEqual({ eventId: "event_1", status: "deleted" })
    expect(await requests[0]?.json()).toEqual({ subject: "Updated" })
    expect(await requests[1]?.json()).toEqual({
      start: { dateTime: "2026-09-10T10:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-09-10T11:00:00Z", timeZone: "UTC" },
      location: { displayName: "" },
    })
    expect(await requests[2]?.json()).toEqual({ comment: "Cancelled by organizer" })
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["PATCH", "/v1.0/me/events/event_1"], ["PATCH", "/v1.0/me/events/event_1"],
      ["POST", "/v1.0/me/events/event_1/cancel"], ["DELETE", "/v1.0/me/events/event_1"],
    ])
    expect(await requests[3]?.text()).toBe("")
  })

  test("renames or moves a OneDrive item and creates folders with conflict failure, never overwrite", async () => {
    const requests: Request[] = []
    const client = new MicrosoftGraphClient({ accessToken: "member-token", fetch: async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      return json({ id: "item_1", name: "Plans", folder: {} }, request.method === "POST" ? 201 : 200)
    } })
    await client.updateDriveItem("item_1", { name: "Plans", parentId: "folder_2" })
    await client.updateDriveItem("item_1", { name: "Renamed" })
    expect(await client.createDriveFolder({ parentId: "folder_2", name: "Plans" })).toMatchObject({ id: "item_1", kind: "folder" })
    expect(await requests[0]?.json()).toEqual({ name: "Plans", parentReference: { id: "folder_2" } })
    expect(await requests[1]?.json()).toEqual({ name: "Renamed" })
    expect(await requests[2]?.json()).toEqual({ name: "Plans", folder: {}, "@microsoft.graph.conflictBehavior": "fail" })
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["PATCH", "/v1.0/me/drive/items/item_1"], ["PATCH", "/v1.0/me/drive/items/item_1"],
      ["POST", "/v1.0/me/drive/items/folder_2/children"],
    ])
  })

  test("rejects malformed or oversized mutation JSON rather than manufacturing a success receipt", async () => {
    for (const response of [json({}), json({ id: "x".repeat(100) }), new Response("invalid"), json({ id: "reply_1", isDraft: false }, 201)]) {
      let calls = 0
      const client = new MicrosoftGraphClient({ accessToken: "member-token", maxJsonResponseBytes: 50, fetch: async () => { calls += 1; return response } })
      const operation = response.status === 201 ? client.createMailReplyDraft("message_1", "Reply") : client.updateMailMessage("message_1", { isRead: true })
      await expect(operation).rejects.toBeInstanceOf(MicrosoftGraphMutationOutcomeUnknownError)
      expect(calls).toBe(1)
    }
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
