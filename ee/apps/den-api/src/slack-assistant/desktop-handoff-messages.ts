/**
 * What a Slack thread is told about work it handed to the member's desktop.
 * Pure functions: the sweep in desktop-handoff.ts decides when to post.
 */

/** How much of the desktop's answer goes into the thread; the full answer stays in OpenWork. */
export const FINISHED_TEXT_LIMIT = 600
const ERROR_TEXT_LIMIT = 300

/**
 * Model and desktop text is untrusted. Escaping `&`, `<` and `>` turns Slack's
 * control sequences (`<@U…>`, `<!here>`, `<!subteam^…>`, `<https://…|label>`)
 * into plain text, and a zero-width space keeps `@here`, `@channel` and
 * `@everyone` from ever being read as a broadcast.
 */
export function slackSafeText(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/@(here|channel|everyone)\b/gi, "@\u200b$1")
}

/** Shortens on a word boundary and closes a code block the cut left open. */
export function excerpt(text: string, limit: number) {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  const cut = trimmed.slice(0, limit)
  const boundary = cut.lastIndexOf(" ")
  let short = `${(boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`
  if ((short.match(/```/g) ?? []).length % 2 === 1) short += "\n```"
  return short
}

/** Mentions the person so Slack notifies them; anything that is not a Slack user id is left out. */
function mention(recipientUserId: string) {
  return /^[UW][A-Z0-9]{2,}$/.test(recipientUserId) ? `<@${recipientUserId}> ` : ""
}

function sentence(text: string) {
  return text.trim().replace(/[.!?\s]+$/, "")
}

export type DesktopHandoffNotice =
  | { kind: "finished"; finalText: string | null }
  | { kind: "failed"; message: string | null }
  | { kind: "waiting"; waitingFor: "permission" | "question" | null }
  | { kind: "expired" }
  | { kind: "undeliverable"; message: string | null; code?: string | null }

export function desktopHandoffMessage(recipientUserId: string, notice: DesktopHandoffNotice) {
  const to = mention(recipientUserId)
  switch (notice.kind) {
    case "finished": {
      const answer = notice.finalText?.trim() ? slackSafeText(excerpt(notice.finalText, FINISHED_TEXT_LIMIT)) : ""
      return answer ? `${to}Your desktop finished: ${answer}` : `${to}Your desktop finished.`
    }
    case "failed": {
      const reason = notice.message?.trim() ? `: ${slackSafeText(sentence(excerpt(notice.message, ERROR_TEXT_LIMIT)))}` : ""
      return `${to}The task on your desktop failed${reason}. It's still open in OpenWork on that computer.`
    }
    case "waiting":
      return notice.waitingFor === "question"
        ? `${to}Your desktop is waiting for you to answer a question in OpenWork.`
        : `${to}Your desktop is waiting for you to approve something in OpenWork.`
    case "expired":
      return `${to}Your desktop didn't pick up the task in time, so it didn't run. Make sure OpenWork is open on that computer, then ask again.`
    case "undeliverable": {
      // The desktop app took the task but OpenWork itself was not running there.
      if (notice.code === "openwork_unreachable") {
        return `${to}Couldn't start the task: OpenWork isn't running on your desktop. Open it, then ask me again.`
      }
      const reason = notice.message?.trim() ? `: ${slackSafeText(sentence(excerpt(notice.message, ERROR_TEXT_LIMIT)))}` : ""
      return `${to}The task couldn't start on your desktop${reason}.`
    }
  }
}
