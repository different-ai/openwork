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

function decodeRawBody(raw: string): string {
  const encoded = decodeRaw(raw).match(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/)?.[1] ?? ""
  return Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString("utf8")
}

function decodeAlternativeBodies(raw: string): { plain: string; html: string } {
  const decoded = decodeRaw(raw)
  const parts = [...decoded.matchAll(/Content-Type: text\/(plain|html); charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)]
  const decodePart = (kind: string) => {
    const encoded = parts.find((part) => part[1] === kind)?.[2] ?? ""
    return Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString("utf8")
  }
  return { plain: decodePart("plain"), html: decodePart("html") }
}

function expectFoldedBase64Payloads(decoded: string) {
  const payloads = [...decoded.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)]
  expect(payloads.length).toBeGreaterThan(0)
  for (const payload of payloads) {
    expect(payload[1]!.split("\r\n").every((line) => line.length <= 76)).toBe(true)
  }
}

describe("buildGmailDraftRaw", () => {
  test("encodes a plain-ASCII draft as base64url multipart/alternative", () => {
    const raw = gmail.buildGmailDraftRaw({ to: "sam@acme.test", subject: "Follow up", body: "Hello Sam" })
    const decoded = Buffer.from(raw, "base64url").toString("utf8")
    expect(decoded).toContain("To: sam@acme.test\r\n")
    expect(decoded).toContain("Subject: Follow up\r\n")
    expect(decoded).toContain("Content-Type: multipart/alternative;")
    expect(decoded.indexOf('Content-Type: text/plain; charset="UTF-8"')).toBeLessThan(decoded.indexOf('Content-Type: text/html; charset="UTF-8"'))
    expect(decodeAlternativeBodies(raw)).toEqual({ plain: "Hello Sam", html: "<div>Hello Sam</div>" })
    // base64url alphabet only — Gmail rejects standard base64 for `raw`.
    expect(raw).not.toMatch(/[+/=]/)
  })

  test("non-ASCII subjects get RFC 2047 B-encoding, bodies survive UTF-8 round trips", () => {
    const raw = gmail.buildGmailDraftRaw({ to: "sam@acme.test", subject: "Résumé — próxima reunión", body: "Grüße aus Zürich ✅" })
    const decoded = decodeRaw(raw)
    const subjectLine = decoded.split("\r\n").find((line) => line.startsWith("Subject: "))
    expect(subjectLine).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
    expect(Buffer.from(subjectLine!.slice("Subject: =?UTF-8?B?".length, -2), "base64").toString("utf8")).toBe("Résumé — próxima reunión")
    expect(decodeAlternativeBodies(raw)).toEqual({ plain: "Grüße aus Zürich ✅", html: "<div>Grüße aus Zürich ✅</div>" })
  })

  test("unwraps long prose and preserves blank lines, lists, and escaped text in equivalent alternatives", () => {
    const body = [
      "Thanks again for the conversation today. As promised, I have attached",
      "a revised indicative pricing proposal for the air-gapped on-premises",
      "deployment, covering both the minimal self-managed path and a",
      "full-support option.",
      "",
      "Options for <Sam> & team:",
      "- Self-managed deployment",
      "- Full-support deployment",
      "",
      "Thanks again!",
      "",
      "Ben",
    ].join("\n")
    const raw = gmail.buildGmailDraftRaw({ to: "sam@acme.test", subject: "Follow up", body })
    const expectedPlain = [
      "Thanks again for the conversation today. As promised, I have attached a revised indicative pricing proposal for the air-gapped on-premises deployment, covering both the minimal self-managed path and a full-support option.",
      "",
      "Options for <Sam> & team:",
      "- Self-managed deployment",
      "- Full-support deployment",
      "",
      "Thanks again!",
      "",
      "Ben",
    ].join("\n")
    expect(decodeAlternativeBodies(raw)).toEqual({
      plain: expectedPlain,
      html: "<div>Thanks again for the conversation today. As promised, I have attached a revised indicative pricing proposal for the air-gapped on-premises deployment, covering both the minimal self-managed path and a full-support option.</div><div><br></div><div>Options for &lt;Sam&gt; &amp; team:</div><div>- Self-managed deployment</div><div>- Full-support deployment</div><div><br></div><div>Thanks again!</div><div><br></div><div>Ben</div>",
    })
    expectFoldedBase64Payloads(decodeRaw(raw))
  })

  test("strips conservative markdown from prose while preserving structure", () => {
    const hardWrapped = [
      "This generated sentence is intentionally long enough to look like it",
      "was hard-wrapped before reaching Gmail and should become one line.",
    ].join("\n")
    const body = [
      "# Status update",
      "",
      "Please **review** the __terms__ and `confirm` before launch.",
      "",
      "- **Keep list marker**",
      "> **Keep quoted text**",
      "```",
      "# keep fenced heading",
      "```",
      "",
      hardWrapped,
    ].join("\n")

    expect(decodeRawBody(gmail.buildGmailDraftRaw({ to: "sam@acme.test", subject: "Follow up", body }))).toBe([
      "Status update",
      "",
      "Please review the terms and confirm before launch.",
      "",
      "- **Keep list marker**",
      "> **Keep quoted text**",
      "```",
      "# keep fenced heading",
      "```",
      "",
      "This generated sentence is intentionally long enough to look like it was hard-wrapped before reaching Gmail and should become one line.",
    ].join("\n"))
  })

  test("closes the top-level alternative boundary when optional fields are absent", () => {
    const raw = gmail.buildGmailDraftRaw({ to: "sam@acme.test", subject: "Follow up", body: "Hello Sam" })
    const decoded = decodeRaw(raw)
    const boundary = decoded.match(/Content-Type: multipart\/alternative; boundary="([^"]+)"/)?.[1]
    expect(boundary).toStartWith("openwork-alternative-")
    expect(decoded).toEndWith(`--${boundary}--\r\n`)
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
    expect(boundary).toStartWith("openwork-mixed-")
    expect(decoded).toContain("Content-Type: multipart/mixed;")
    expect(decoded).toMatch(/Content-Type: multipart\/mixed;[^]*?\r\n\r\n--openwork-mixed-[^\r\n]+\r\nContent-Type: multipart\/alternative;/)
    expect(decoded.indexOf('Content-Type: text/plain; charset="UTF-8"')).toBeLessThan(decoded.indexOf('Content-Type: text/html; charset="UTF-8"'))
    expect(decoded).toContain('Content-Type: application/pdf; name="invoice \\"final\\".pdf"')
    expect(decoded).toContain('Content-Disposition: attachment; filename="invoice \\"final\\".pdf"')
    expect(decoded).toContain(Buffer.from("%PDF attachment bytes", "utf8").toString("base64"))
    expect(decoded).toContain(`--${boundary}--\r\n`)
    expectFoldedBase64Payloads(decoded)
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

describe("Gmail web links", () => {
  test("targets the connected account when its email is known", () => {
    expect(gmail.gmailDraftUrl("draft id", "user+work@example.com")).toBe(
      "https://mail.google.com/mail/u/?authuser=user%2Bwork%40example.com#drafts?compose=draft%20id",
    )
    expect(gmail.gmailThreadUrl("thread/id", "user+work@example.com")).toBe(
      "https://mail.google.com/mail/u/?authuser=user%2Bwork%40example.com#all/thread%2Fid",
    )
  })

  test("keeps the legacy u/0 links when the account email is unknown", () => {
    expect(gmail.gmailDraftUrl("draft id")).toBe("https://mail.google.com/mail/u/0/#drafts?compose=draft%20id")
    expect(gmail.gmailThreadUrl("thread/id")).toBe("https://mail.google.com/mail/u/0/#all/thread%2Fid")
  })
})
