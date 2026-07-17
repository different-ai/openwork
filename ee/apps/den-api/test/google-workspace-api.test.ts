import { describe, expect, test } from "bun:test"
import {
  buildDriveMultipartUpload,
  buildDriveSearchQuery,
  buildGmailQuoteBlock,
  extractCalendarEvents,
  extractDriveFiles,
  extractDrivePermission,
  extractGmailAttachmentData,
  extractGmailMessage,
  truncateText,
} from "../src/capability-sources/google-workspace-api.js"

function base64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url")
}

describe("buildGmailQuoteBlock", () => {
  test("formats parsed dates in UTC and prefixes every line", () => {
    expect(buildGmailQuoteBlock({
      from: "Ada <ada@example.com>",
      date: "Thu, 16 Jul 2026 15:21:00 +0000",
      body: "First line\n> nested quote",
    })).toBe([
      "On Thu, 16 Jul 2026 at 15:21 UTC, Ada <ada@example.com> wrote:",
      "> First line",
      "> > nested quote",
    ].join("\n"))
  })

  test("uses raw invalid dates and omits the date header when absent", () => {
    expect(buildGmailQuoteBlock({ from: "Ada", date: "not a date", body: "Hi" })).toBe([
      "On not a date, Ada wrote:",
      "> Hi",
    ].join("\n"))
    expect(buildGmailQuoteBlock({ from: "Ada", date: "", body: "Hi" })).toBe([
      "Ada wrote:",
      "> Hi",
    ].join("\n"))
  })

  test("truncates quoted bodies and appends a trim marker", () => {
    const quote = buildGmailQuoteBlock({ from: "Ada", date: "", body: "x".repeat(10_001) })
    expect(quote).toContain(`> ${"x".repeat(10_000)}`)
    expect(quote.endsWith("\n> [message trimmed]")).toBe(true)
  })
})

describe("extractGmailMessage", () => {
  test("reads headers, nested plain-text body, and attachment metadata", () => {
    const message = extractGmailMessage({
      id: "msg_1",
      threadId: "thread_1",
      snippet: "Snippet fallback",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "Ada <ada@example.com>" },
          { name: "To", value: "Ben <ben@example.com>" },
          { name: "Subject", value: "Nested body" },
          { name: "Date", value: "Tue, 07 Jul 2026 10:00:00 +0000" },
        ],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/html", body: { data: base64Url("<p>HTML <strong>fallback</strong></p>") } },
              { mimeType: "text/plain", body: { data: base64Url("Plain body from Gmail") } },
            ],
          },
          {
            filename: "report.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "att_1", size: 1234 },
          },
        ],
      },
    })

    expect(message).toEqual({
      id: "msg_1",
      threadId: "thread_1",
      from: "Ada <ada@example.com>",
      to: "Ben <ben@example.com>",
      subject: "Nested body",
      date: "Tue, 07 Jul 2026 10:00:00 +0000",
      snippet: "Snippet fallback",
      body: "Plain body from Gmail",
      attachments: [{ attachmentId: "att_1", filename: "report.pdf", mimeType: "application/pdf", size: 1234 }],
    })
  })

  test("falls back from stripped html to snippet", () => {
    expect(extractGmailMessage({
      snippet: "Snippet text",
      payload: { mimeType: "text/html", body: { data: base64Url("<div>Hello <b>HTML</b></div>") } },
    }).body).toBe("Hello HTML")

    expect(extractGmailMessage({ snippet: "Snippet text", payload: {} }).body).toBe("Snippet text")
  })

  test("truncates long bodies to Gmail's route budget", () => {
    const message = extractGmailMessage({
      snippet: "short",
      payload: { mimeType: "text/plain", body: { data: base64Url("x".repeat(100_010)) } },
    })
    expect(message.body.length).toBe(100_000)
  })
})

describe("extractGmailAttachmentData", () => {
  test("normalizes base64url data to standard base64 and keeps Gmail's size", () => {
    // "----_w" decodes to bytes fb ef be ff; standard base64 re-encodes them as "++++/w==".
    expect(extractGmailAttachmentData({ size: 4, data: "----_w" })).toEqual({ size: 4, dataBase64: "++++/w==" })
  })

  test("falls back to decoded byte length when size is missing", () => {
    expect(extractGmailAttachmentData({ data: base64Url("hello") })).toEqual({
      size: 5,
      dataBase64: Buffer.from("hello", "utf8").toString("base64"),
    })
  })

  test("returns null when Gmail sends no data", () => {
    expect(extractGmailAttachmentData({ size: 4 })).toBeNull()
    expect(extractGmailAttachmentData(null)).toBeNull()
  })
})

describe("extractCalendarEvents", () => {
  test("maps dateTime and all-day date events", () => {
    expect(extractCalendarEvents({
      items: [
        {
          id: "event_1",
          summary: "Planning",
          description: "Discuss launch",
          location: "Room 1",
          start: { dateTime: "2026-07-08T10:00:00Z" },
          end: { dateTime: "2026-07-08T10:30:00Z" },
          status: "confirmed",
          htmlLink: "https://calendar.google.com/event?eid=event_1",
          attendees: [{ email: "ada@example.com" }, { email: "ben@example.com" }],
        },
        {
          id: "event_2",
          summary: "Offsite",
          start: { date: "2026-07-09" },
          end: { date: "2026-07-10" },
        },
      ],
    })).toEqual([
      {
        id: "event_1",
        summary: "Planning",
        description: "Discuss launch",
        location: "Room 1",
        start: "2026-07-08T10:00:00Z",
        end: "2026-07-08T10:30:00Z",
        status: "confirmed",
        htmlLink: "https://calendar.google.com/event?eid=event_1",
        attendees: ["ada@example.com", "ben@example.com"],
        meetLink: null,
      },
      {
        id: "event_2",
        summary: "Offsite",
        description: "",
        location: "",
        start: "2026-07-09",
        end: "2026-07-10",
        status: "",
        htmlLink: "",
        attendees: [],
        meetLink: null,
      },
    ])
  })
})

describe("Drive helpers", () => {
  test("buildDriveSearchQuery escapes quotes and backslashes", () => {
    expect(buildDriveSearchQuery("it's \\ tricky")).toBe("trashed = false and (name contains 'it\\'s \\\\ tricky' or fullText contains 'it\\'s \\\\ tricky')")
  })

  test("buildDriveMultipartUpload frames metadata and preserves binary bytes", () => {
    const boundary = "openwork-test-boundary"
    const content = Buffer.from([0x00, 0xfb, 0xef, 0xbe, 0xff, 0x61])
    const metadata = { name: "Résumé.txt", parents: ["folder_1"] }
    const body = buildDriveMultipartUpload({ metadata, content, mimeType: "text/plain", boundary })
    const prefix = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n`, "utf8")
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")

    expect(body.equals(Buffer.concat([prefix, content, suffix]))).toBe(true)
    expect(body.subarray(prefix.byteLength, prefix.byteLength + content.byteLength).equals(content)).toBe(true)
  })

  test("extractDriveFiles maps file metadata and preserves absent size as null", () => {
    expect(extractDriveFiles({
      files: [
        {
          id: "file_1",
          name: "Notes.txt",
          mimeType: "text/plain",
          modifiedTime: "2026-07-08T11:00:00Z",
          webViewLink: "https://drive.google.com/file/d/file_1/view",
          size: "42",
        },
        {
          id: "doc_1",
          name: "Doc",
          mimeType: "application/vnd.google-apps.document",
          modifiedTime: "2026-07-08T12:00:00Z",
          webViewLink: "https://docs.google.com/document/d/doc_1/edit",
        },
      ],
    })).toEqual([
      {
        id: "file_1",
        name: "Notes.txt",
        mimeType: "text/plain",
        modifiedTime: "2026-07-08T11:00:00Z",
        webViewLink: "https://drive.google.com/file/d/file_1/view",
        size: "42",
      },
      {
        id: "doc_1",
        name: "Doc",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2026-07-08T12:00:00Z",
        webViewLink: "https://docs.google.com/document/d/doc_1/edit",
        size: null,
      },
    ])
  })

  test("extractDrivePermission maps permission fields", () => {
    expect(extractDrivePermission({ id: "perm_1", type: "domain", role: "reader", ignored: true })).toEqual({
      id: "perm_1",
      type: "domain",
      role: "reader",
    })
  })
})

describe("truncateText", () => {
  test("reports whether content was truncated", () => {
    expect(truncateText("short", 10)).toEqual({ text: "short", truncated: false })
    expect(truncateText("abcdef", 3)).toEqual({ text: "abc", truncated: true })
  })
})
