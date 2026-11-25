import type { HarnessFeedbackGroupTable } from "@openwork-ee/den-db/schema"
import { harnessFeedbackCategoryLabel } from "./classifier.js"
import { HARNESS_FEEDBACK_THEME_LABELS } from "./themes.js"

export type SlackFeedbackGroup = Pick<typeof HarnessFeedbackGroupTable.$inferSelect, "id" | "title" | "theme" | "category" | "tool">
export type SlackDelivery = "delivered" | "permanent" | "transient" | "uncertain"
export type HarnessFeedbackSender = (group: SlackFeedbackGroup) => Promise<SlackDelivery>

const HEADING = "New harness issue"

export function escapeSlack(value: string) {
  return value.replace(/\s+/gu, " ").replace(/@(?=channel\b|here\b|everyone\b)/giu, "@\u200b")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

const WORD_JOINER = "\u2060"

export function cleanHarnessFeedbackText(value: string) {
  return value.replace(/\s+/gu, " ").replace(/\p{C}/gu, "").trim()
}

export function neutralizeHarnessFeedbackSlackText(value: string) {
  return cleanHarnessFeedbackText(value)
    .replace(/(?:[\w+.-]+:\/\/[^\s<>]+|[\p{L}\p{N}-]+(?:[.\u3002\uff0e\uff61][\p{L}\p{N}-]+)+)/gu,
      (link) => link.replace("://", `:${WORD_JOINER}//`).replace(/[.\u3002\uff0e\uff61]/gu, (dot) => `${dot}${WORD_JOINER}`))
    .replaceAll("@", "＠").replaceAll("<", "‹").replaceAll(">", "›")
}

function message(group: SlackFeedbackGroup, webUrl: string) {
  const link = new URL("/admin/harness-feedback", webUrl)
  link.searchParams.set("group", group.id)
  const details = [
    escapeSlack(neutralizeHarnessFeedbackSlackText(group.title)),
    `Theme: ${group.theme ? HARNESS_FEEDBACK_THEME_LABELS[group.theme] : "Unassigned"}`,
    `Category: ${escapeSlack(harnessFeedbackCategoryLabel(group.category) ?? "Uncategorized")}`,
    ...(group.tool ? [`Tool: ${escapeSlack(neutralizeHarnessFeedbackSlackText(group.tool))}`] : []),
  ].join("\n")
  return {
    ...slackPayload(`${HEADING}\n${details}\n${escapeSlack(link.href)}`),
    blocks: [
      { type: "header", text: { type: "plain_text", text: HEADING } },
      { type: "section", text: { type: "plain_text", text: details } },
      { type: "section", text: { type: "mrkdwn", verbatim: true, text: `<${escapeSlack(link.href)}|Open in Den admin>` } },
    ],
  }
}

function isPreConnectError(error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return false
  return ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"].some((code) => code === cause.code)
}

export function normalizeHarnessFeedbackWebhook(value: string) {
  const url = URL.parse(value.trim())
  if (url?.origin !== "https://hooks.slack.com" || url.username || url.password || url.search || url.hash) return null
  return url.href
}

export function slackPayload(text: string) {
  return { text, mrkdwn: false, link_names: 0, parse: "none", unfurl_links: false, unfurl_media: false }
}

export function sendHarnessFeedbackSlackTest(webhookUrl: string) {
  return postToSlack({ webhookUrl }, slackPayload("Test message from OpenWork harness feedback."))
}

type SlackTransport = { webhookUrl: string; fetch?: typeof fetch; timeoutMs?: number }

export function createHarnessFeedbackSlackSender(options: SlackTransport & { webUrl: string }): HarnessFeedbackSender {
  return (group) => postToSlack(options, message(group, options.webUrl))
}

export async function postToSlack(options: SlackTransport, payload: ReturnType<typeof slackPayload> & { blocks?: ReturnType<typeof message>["blocks"] }): Promise<SlackDelivery> {
  const send = options.fetch ?? fetch
  const signal = AbortSignal.timeout(options.timeoutMs ?? 5_000)
  let response: Response
  try {
    response = await send(options.webhookUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload), signal, redirect: "manual",
    })
  } catch (error) {
    return !signal.aborted && isPreConnectError(error) ? "transient" : "uncertain"
  }
  void response.body?.cancel().catch(() => {})
  if (response.ok) return "delivered"
  if (response.status === 429 || response.status >= 500) return "transient"
  return "permanent"
}
