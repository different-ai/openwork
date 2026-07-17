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

function encodeMimeParameter(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function base64MimeContent(content: Buffer): string {
  return content.toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? ""
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
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`
}

/** Tolerant reader for the Gmail drafts.create response body. */
export function readGmailDraftIds(text: string): { draftId: string | null; messageId: string | null } {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null) {
      return { draftId: null, messageId: null }
    }
    const draftId = "id" in parsed && typeof parsed.id === "string" ? parsed.id : null
    let messageId: string | null = null
    if ("message" in parsed && typeof parsed.message === "object" && parsed.message !== null
      && "id" in parsed.message && typeof parsed.message.id === "string") {
      messageId = parsed.message.id
    }
    return { draftId, messageId }
  } catch {
    return { draftId: null, messageId: null }
  }
}

export function buildGmailDraftRaw(input: { to: string; cc?: string; bcc?: string; subject: string; body: string; headers?: { name: string; value: string }[]; attachments?: GmailDraftAttachment[] }): string {
  const headers = [
    `To: ${input.to}`,
    input.cc ? `Cc: ${input.cc}` : null,
    input.bcc ? `Bcc: ${input.bcc}` : null,
    `Subject: ${encodeMimeHeaderValue(input.subject)}`,
    ...(input.headers ?? []).map((header) => `${header.name}: ${header.value}`),
  ].filter((line) => typeof line === "string")
  const attachments = input.attachments ?? []
  const body = normalizeDraftBody(input.body)
  const message = attachments.length === 0 ? [
    ...headers,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf8").toString("base64"),
  ].join("\r\n") : (() => {
    const boundary = `openwork-${randomUUID()}`
    return [
      ...headers,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(body, "utf8").toString("base64"),
      ...attachments.flatMap((attachment) => [
        `--${boundary}`,
        `Content-Type: ${attachment.mimeType}; name="${encodeMimeParameter(attachment.filename)}"`,
        `Content-Disposition: attachment; filename="${encodeMimeParameter(attachment.filename)}"`,
        "Content-Transfer-Encoding: base64",
        "",
        base64MimeContent(attachment.content),
      ]),
      `--${boundary}--`,
      "",
    ].join("\r\n")
  })()
  return Buffer.from(message, "utf8").toString("base64url")
}
