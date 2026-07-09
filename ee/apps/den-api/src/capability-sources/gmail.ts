/**
 * Minimal Gmail draft construction: an RFC 822 message, base64url-encoded
 * the way the Gmail API `users.messages/drafts` endpoints expect `raw`.
 * Kept pure so the encoding is unit-testable without any HTTP.
 */

function hasNonAscii(value: string): boolean {
  for (const char of value) {
    if (char.codePointAt(0)! > 0x7e || char.codePointAt(0)! < 0x20) return true
  }
  return false
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

export function buildGmailDraftRaw(input: { to: string; cc?: string; bcc?: string; subject: string; body: string; headers?: { name: string; value: string }[] }): string {
  const message = [
    `To: ${input.to}`,
    input.cc ? `Cc: ${input.cc}` : null,
    input.bcc ? `Bcc: ${input.bcc}` : null,
    `Subject: ${encodeMimeHeaderValue(input.subject)}`,
    ...(input.headers ?? []).map((header) => `${header.name}: ${header.value}`),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.body, "utf8").toString("base64"),
  ].filter((line) => typeof line === "string").join("\r\n")
  return Buffer.from(message, "utf8").toString("base64url")
}
