import { composeSlackMessages, markdownToSlackParts, type SlackComposeOptions, type SlackOutgoingMessage } from "./rich-message.js"
import { excerpt, markdownToMrkdwn, markdownToPlainText, SECTION_TEXT_LIMIT, slackSafeText, splitSlackText } from "./slack-text.js"

export { excerpt, slackSafeText } from "./slack-text.js"

const ERROR_TEXT_LIMIT = 300
const NOTIFICATION_TEXT_LIMIT = 300
const MAX_SECTIONS = 50

export type SlackMessage = {
  text: string
  blocks?: Array<{ type: "section"; text: { type: "mrkdwn"; text: string } }>
}

function mention(recipientUserId: string) {
  return /^[UW][A-Z0-9]{2,}$/.test(recipientUserId) ? `<@${recipientUserId}> ` : ""
}

function sentence(text: string) {
  return text.trim().replace(/[.!?\s]+$/, "")
}

function reason(message: string | null) {
  return message?.trim() ? `: ${markdownToMrkdwn(sentence(excerpt(markdownToPlainText(message), ERROR_TEXT_LIMIT)))}` : ""
}

function section(text: string) {
  return { type: "section" as const, text: { type: "mrkdwn" as const, text } }
}

function finishedMessage(to: string, finalText: string): SlackMessage {
  const answer = markdownToMrkdwn(finalText)
  const startsWithBlock = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\|)/.test(finalText.trim())
  const lead = `${to}Your desktop finished:${startsWithBlock ? "\n" : " "}`
  const parts = splitSlackText(`${lead}${answer}`, SECTION_TEXT_LIMIT)
  const shown = parts.length > MAX_SECTIONS
    ? [...parts.slice(0, MAX_SECTIONS - 1), "_The rest of this answer is in OpenWork on that computer._"]
    : parts
  return {
    text: `${to}Your desktop finished: ${slackSafeText(excerpt(markdownToPlainText(finalText), NOTIFICATION_TEXT_LIMIT))}`,
    blocks: shown.map(section),
  }
}

const MAX_RICH_MESSAGES = 6
export const DESKTOP_HANDOFF_REST_LINE = "_The rest of this answer is in OpenWork on that computer._"

export function desktopHandoffRichMessages(
  recipientUserId: string,
  notice: DesktopHandoffNotice,
  options: Pick<SlackComposeOptions, "places" | "imageUrl">,
): { messages: SlackOutgoingMessage[]; cut: boolean } | null {
  if (notice.kind !== "finished" || !notice.finalText?.trim()) return null
  const messages = composeSlackMessages([{ type: "mrkdwn", text: `${mention(recipientUserId)}Your desktop finished:` }, ...markdownToSlackParts(notice.finalText).parts], options)
  return { messages: messages.slice(0, MAX_RICH_MESSAGES), cut: messages.length > MAX_RICH_MESSAGES }
}

export type DesktopHandoffNotice =
  | { kind: "finished"; finalText: string | null }
  | { kind: "failed"; message: string | null }
  | { kind: "waiting"; waitingFor: "permission" | "question" | null }
  | { kind: "expired" }
  | { kind: "undeliverable"; message: string | null; code?: string | null }

export function desktopHandoffMessage(recipientUserId: string, notice: DesktopHandoffNotice): SlackMessage {
  const to = mention(recipientUserId)
  switch (notice.kind) {
    case "finished":
      return notice.finalText?.trim() ? finishedMessage(to, notice.finalText) : { text: `${to}Your desktop finished.` }
    case "failed":
      return { text: `${to}The task on your desktop failed${reason(notice.message)}. It's still open in OpenWork on that computer.` }
    case "waiting":
      return {
        text: notice.waitingFor === "question"
          ? `${to}Your desktop is waiting for you to answer a question in OpenWork.`
          : `${to}Your desktop is waiting for you to approve something in OpenWork.`,
      }
    case "expired":
      return { text: `${to}Your desktop didn't pick up the task in time, so it didn't run. Make sure OpenWork is open on that computer, then ask again.` }
    case "undeliverable": {
      if (notice.code === "openwork_unreachable") {
        return { text: `${to}Couldn't start the task: OpenWork isn't running on your desktop. Open it, then ask me again.` }
      }
      return { text: `${to}The task couldn't start on your desktop${reason(notice.message)}.` }
    }
  }
}
