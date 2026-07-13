import { beforeAll, describe, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let gmail: typeof import("../src/capability-sources/gmail.js")
let googleWorkspaceApi: typeof import("../src/capability-sources/google-workspace-api.js")

beforeAll(async () => {
  seedRequiredEnv()
  gmail = await import("../src/capability-sources/gmail.js")
  googleWorkspaceApi = await import("../src/capability-sources/google-workspace-api.js")
})

function decodeRaw(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8")
}

describe("buildGmailDraftRaw", () => {
  test("encodes a plain-ASCII draft as base64url RFC 822 with the body base64-encoded", () => {
    const raw = gmail.buildGmailDraftRaw({ to: "sam@acme.test", subject: "Follow up", body: "Hello Sam" })
    const decoded = Buffer.from(raw, "base64url").toString("utf8")
    expect(decoded).toContain("To: sam@acme.test\r\n")
    expect(decoded).toContain("Subject: Follow up\r\n")
    expect(decoded).toContain('Content-Type: text/plain; charset="UTF-8"')
    const bodyPart = decoded.split("\r\n\r\n")[1]
    expect(Buffer.from(bodyPart, "base64").toString("utf8")).toBe("Hello Sam")
    // base64url alphabet only — Gmail rejects standard base64 for `raw`.
    expect(raw).not.toMatch(/[+/=]/)
  })

  test("non-ASCII subjects get RFC 2047 B-encoding, bodies survive UTF-8 round trips", () => {
    const raw = gmail.buildGmailDraftRaw({ to: "sam@acme.test", subject: "Résumé — próxima reunión", body: "Grüße aus Zürich ✅" })
    const decoded = decodeRaw(raw)
    const subjectLine = decoded.split("\r\n").find((line) => line.startsWith("Subject: "))
    expect(subjectLine).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
    expect(Buffer.from(subjectLine!.slice("Subject: =?UTF-8?B?".length, -2), "base64").toString("utf8")).toBe("Résumé — próxima reunión")
    const bodyPart = decoded.split("\r\n\r\n")[1]
    expect(Buffer.from(bodyPart, "base64").toString("utf8")).toBe("Grüße aus Zürich ✅")
  })

  test("keeps legacy draft output unchanged when optional fields are absent", () => {
    const raw = gmail.buildGmailDraftRaw({ to: "sam@acme.test", subject: "Follow up", body: "Hello Sam" })
    expect(decodeRaw(raw)).toBe([
      "To: sam@acme.test",
      "Subject: Follow up",
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("Hello Sam", "utf8").toString("base64"),
    ].join("\r\n"))
  })

  test("emits Cc and Bcc header lines exactly when provided", () => {
    const decoded = decodeRaw(gmail.buildGmailDraftRaw({
      to: "sam@acme.test",
      cc: "ada@acme.test, grace@acme.test",
      bcc: "hidden@acme.test",
      subject: "Follow up",
      body: "Hello Sam",
    }))
    expect(decoded.split("\r\n").slice(0, 4)).toEqual([
      "To: sam@acme.test",
      "Cc: ada@acme.test, grace@acme.test",
      "Bcc: hidden@acme.test",
      "Subject: Follow up",
    ])

    const ccOnly = decodeRaw(gmail.buildGmailDraftRaw({
      to: "sam@acme.test",
      cc: "ada@acme.test",
      subject: "Follow up",
      body: "Hello Sam",
    }))
    expect(ccOnly.split("\r\n").slice(0, 3)).toEqual([
      "To: sam@acme.test",
      "Cc: ada@acme.test",
      "Subject: Follow up",
    ])
    expect(ccOnly).not.toContain("Bcc:")
  })

  test("emits extra headers before MIME headers", () => {
    const decoded = decodeRaw(gmail.buildGmailDraftRaw({
      to: "sam@acme.test",
      subject: "Re: Follow up",
      body: "Hello Sam",
      headers: [
        { name: "In-Reply-To", value: "<orig-2@mail.gmail.com>" },
        { name: "References", value: "<orig-1@mail.gmail.com> <orig-2@mail.gmail.com>" },
      ],
    }))
    expect(decoded.split("\r\n").slice(0, 5)).toEqual([
      "To: sam@acme.test",
      "Subject: Re: Follow up",
      "In-Reply-To: <orig-2@mail.gmail.com>",
      "References: <orig-1@mail.gmail.com> <orig-2@mail.gmail.com>",
      "MIME-Version: 1.0",
    ])
  })

  test("encodes attachments as multipart MIME while preserving filename, MIME type, and bytes", () => {
    const decoded = decodeRaw(gmail.buildGmailDraftRaw({
      to: "sam@acme.test",
      subject: "Invoice",
      body: "Please review the attached invoice.",
      attachments: [{
        filename: 'invoice "final".pdf',
        mimeType: "application/pdf",
        content: Buffer.from("%PDF attachment bytes", "utf8"),
      }],
    }))
    const boundary = decoded.match(/boundary="([^"]+)"/)?.[1]
    expect(boundary).toStartWith("openwork-")
    expect(decoded).toContain("Content-Type: multipart/mixed;")
    expect(decoded).toContain('Content-Type: application/pdf; name="invoice \\"final\\".pdf"')
    expect(decoded).toContain('Content-Disposition: attachment; filename="invoice \\"final\\".pdf"')
    expect(decoded).toContain(Buffer.from("%PDF attachment bytes", "utf8").toString("base64"))
    expect(decoded).toContain(`--${boundary}--\r\n`)
  })
})

describe("extractGmailThreadReplyContext", () => {
  test("uses the last message Message-ID and appends it to prior References", () => {
    expect(googleWorkspaceApi.extractGmailThreadReplyContext({
      messages: [
        { payload: { headers: [{ name: "Message-ID", value: "<orig-1@mail.gmail.com>" }] } },
        {
          payload: {
            headers: [
              { name: "Message-ID", value: "<orig-2@mail.gmail.com>" },
              { name: "References", value: "<orig-1@mail.gmail.com>" },
            ],
          },
        },
      ],
    })).toEqual({
      lastMessageId: "<orig-2@mail.gmail.com>",
      references: "<orig-1@mail.gmail.com> <orig-2@mail.gmail.com>",
    })
  })

  test("uses only Message-ID when the last message has no References", () => {
    expect(googleWorkspaceApi.extractGmailThreadReplyContext({
      messages: [
        {
          payload: {
            headers: [{ name: "message-id", value: "<orig-2@mail.gmail.com>" }],
          },
        },
      ],
    })).toEqual({
      lastMessageId: "<orig-2@mail.gmail.com>",
      references: "<orig-2@mail.gmail.com>",
    })
  })

  test("returns null for an empty thread", () => {
    expect(googleWorkspaceApi.extractGmailThreadReplyContext({ messages: [] })).toBeNull()
  })

  test("returns null when the last message has no Message-ID", () => {
    expect(googleWorkspaceApi.extractGmailThreadReplyContext({
      messages: [{ payload: { headers: [{ name: "References", value: "<orig-1@mail.gmail.com>" }] } }],
    })).toBeNull()
  })
})

describe("encodeMimeHeaderValue", () => {
  test("leaves ASCII untouched and encodes anything else", () => {
    expect(gmail.encodeMimeHeaderValue("plain subject")).toBe("plain subject")
    expect(gmail.encodeMimeHeaderValue("café")).toBe(`=?UTF-8?B?${Buffer.from("café", "utf8").toString("base64")}?=`)
  })
})

describe("readGmailDraftIds", () => {
  test("reads Gmail-shaped responses", () => {
    expect(gmail.readGmailDraftIds(JSON.stringify({ id: "draft-1", message: { id: "msg-1" } })))
      .toEqual({ draftId: "draft-1", messageId: "msg-1" })
  })

  test("tolerates malformed and partial responses", () => {
    expect(gmail.readGmailDraftIds("not json")).toEqual({ draftId: null, messageId: null })
    expect(gmail.readGmailDraftIds(JSON.stringify({ id: "draft-1" }))).toEqual({ draftId: "draft-1", messageId: null })
    expect(gmail.readGmailDraftIds(JSON.stringify({ message: { id: "msg-1" } }))).toEqual({ draftId: null, messageId: "msg-1" })
    expect(gmail.readGmailDraftIds(JSON.stringify([1, 2]))).toEqual({ draftId: null, messageId: null })
  })
})
