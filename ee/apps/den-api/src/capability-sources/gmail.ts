/**
 * Minimal Gmail draft construction: an RFC 822 message, base64url-encoded
 * the way the Gmail API `users.messages/drafts` endpoints expect `raw`.
 * Kept pure so the encoding is unit-testable without any HTTP.
 */

import { randomUUID } from "node:crypto"

const HARD_WRAP_MIN_LINE_LENGTH = 50

function hasNonAscii(value: string): boolean {
  for (const char of value) {
    if (char.codePointAt(0)! > 0x7e || char.codePointAt(0)! < 0x20) return true
  }
  return false
}

export type GmailDraftAttachment = {
  filename: string
  mimeType: string
  content: Buffer
}

export type GmailDraftQuote = {
  attribution: string
  body: string
}

function encodeMimeParameter(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function base64MimeContent(content: Buffer): string {
  return content.toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? ""
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function draftBodyHtml(body: string): string {
  return body.split("\n").map((line) => `<div>${line.length === 0 ? "<br>" : escapeHtml(line)}</div>`).join("")
}

function alternativeMimeParts(boundary: string, body: string, quote?: GmailDraftQuote): string[] {
  const plain = quote ? `${body}\n\n${quote.attribution}\n${quote.body.split("\n").map((line) => `> ${line}`).join("\n")}` : body
  // Only generated markup is HTML; both new prose and quoted history remain escaped text.
  const html = draftBodyHtml(body) + (quote
    ? `<div><br></div><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${escapeHtml(quote.attribution)}</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${draftBodyHtml(quote.body)}</blockquote></div>`
    : "")
  return [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64MimeContent(Buffer.from(plain, "utf8")),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64MimeContent(Buffer.from(html, "utf8")),
    `--${boundary}--`,
  ]
}

// Generated prose is sometimes hard-wrapped before it reaches Gmail. Those
// literal breaks become visible after send, especially on narrow screens.
function normalizeDraftBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").replace(/[^\n]+(?:\n[^\n]+)*/g, (block) => {
    const lines = block.split("\n")
    const hasStructure = lines.some((line) => {
      const trimmed = line.trimStart()
      return trimmed.length !== line.length || /^(?:[-*+•]\s|\d+[.)]\s|>|```|~~~)/.test(trimmed)
    })
    if (hasStructure) return block

    const cleanedLines = lines.map((line) => line
      .replace(/^#{1,6}\s+/, "")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .replace(/__([^_\n]+)__/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1"))
    const looksHardWrapped = lines.slice(0, -1).every((line) => line.trimEnd().length >= HARD_WRAP_MIN_LINE_LENGTH)
    return lines.length > 1 && looksHardWrapped ? cleanedLines.map((line) => line.trim()).join(" ") : cleanedLines.join("\n")
  })
}

/** RFC 2047 B-encoding for header values that contain non-ASCII characters. */
export function encodeMimeHeaderValue(value: string): string {
  if (!hasNonAscii(value)) {
    return value
  }
  const words: string[] = []
  let chunk = ""
  let chunkBytes = 0
  // 45 UTF-8 bytes become 60 base64 characters, plus the 12-character wrapper.
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8")
    if (chunk && chunkBytes + characterBytes > 45) {
      words.push(chunk)
      chunk = ""
      chunkBytes = 0
    }
    chunk += character
    chunkBytes += characterBytes
  }
  if (chunk) words.push(chunk)
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join(" ")
}

function mimeHeaderLine(name: string, value: string): string {
  if (!name || /[^\x21-\x39\x3b-\x7e]/.test(name)) throw new Error("Invalid MIME header name")
  const sanitized = value.replace(/[\r\n]+/g, " ").trim()
  const line = `${name}: ${name.toLowerCase() === "subject" ? encodeMimeHeaderValue(sanitized) : sanitized}`
  const lines: string[] = []
  let current = ""
  // Fold only at existing whitespace, preserving quoted addresses and opaque tokens.
  for (const word of line.split(/(?=[ \t])/)) {
    if (current && Buffer.byteLength(current + word, "utf8") > 78) {
      lines.push(current)
      current = word
    } else {
      current += word
    }
  }
  if (current) lines.push(current)
  return lines.join("\r\n")
}

/** Tolerant reader for the Gmail drafts.create response body. */
export function readGmailDraftIds(text: string): { draftId: string | null; messageId: string | null; threadId: string | null } {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null) {
      return { draftId: null, messageId: null, threadId: null }
    }
    const draftId = "id" in parsed && typeof parsed.id === "string" ? parsed.id : null
    let messageId: string | null = null
    let threadId: string | null = null
    if ("message" in parsed && typeof parsed.message === "object" && parsed.message !== null) {
      if ("id" in parsed.message && typeof parsed.message.id === "string") messageId = parsed.message.id
      if ("threadId" in parsed.message && typeof parsed.message.threadId === "string") threadId = parsed.message.threadId
    }
    return { draftId, messageId, threadId }
  } catch {
    return { draftId: null, messageId: null, threadId: null }
  }
}

export function gmailDraftUrl(messageId: string | null, accountEmail?: string): string | null {
  if (!messageId) return null
  const mailbox = accountEmail ? `u/?authuser=${encodeURIComponent(accountEmail)}` : "u/0/"
  return `https://mail.google.com/mail/${mailbox}#drafts?compose=${encodeURIComponent(messageId)}`
}

export function gmailThreadUrl(threadId: string | null | undefined, accountEmail?: string): string | null {
  if (!threadId) return null
  const mailbox = accountEmail ? `u/?authuser=${encodeURIComponent(accountEmail)}` : "u/0/"
  return `https://mail.google.com/mail/${mailbox}#all/${encodeURIComponent(threadId)}`
}

export function buildGmailDraftRaw(input: { to: string; cc?: string; bcc?: string; subject: string; body: string; quote?: GmailDraftQuote; headers?: { name: string; value: string }[]; attachments?: GmailDraftAttachment[] }): string {
  const headers = [
    mimeHeaderLine("To", input.to),
    input.cc ? mimeHeaderLine("Cc", input.cc) : null,
    input.bcc ? mimeHeaderLine("Bcc", input.bcc) : null,
    mimeHeaderLine("Subject", input.subject),
    ...(input.headers ?? []).map((header) => mimeHeaderLine(header.name, header.value)),
  ].filter((line) => typeof line === "string")
  const attachments = input.attachments ?? []
  const body = normalizeDraftBody(input.body)
  const alternativeBoundary = `openwork-alternative-${randomUUID()}`
  const message = attachments.length === 0 ? [
    ...headers,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    "",
    ...alternativeMimeParts(alternativeBoundary, body, input.quote),
    "",
  ].join("\r\n") : (() => {
    const mixedBoundary = `openwork-mixed-${randomUUID()}`
    return [
      ...headers,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
      "",
      `--${mixedBoundary}`,
      `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
      "",
      ...alternativeMimeParts(alternativeBoundary, body, input.quote),
      ...attachments.flatMap((attachment) => [
        `--${mixedBoundary}`,
        `Content-Type: ${attachment.mimeType}; name="${encodeMimeParameter(attachment.filename)}"`,
        `Content-Disposition: attachment; filename="${encodeMimeParameter(attachment.filename)}"`,
        "Content-Transfer-Encoding: base64",
        "",
        base64MimeContent(attachment.content),
      ]),
      `--${mixedBoundary}--`,
      "",
    ].join("\r\n")
  })()
  return Buffer.from(message, "utf8").toString("base64url")
}
