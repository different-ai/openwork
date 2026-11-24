import type { HarnessFeedbackGroupTable } from "@openwork-ee/den-db/schema"
import { harnessFeedbackCategoryLabel } from "./classifier.js"
import { harnessFeedbackSurfaceLabel } from "./grouping.js"

export type SlackFeedbackGroup = Pick<typeof HarnessFeedbackGroupTable.$inferSelect, "id" | "title" | "category" | "surface" | "tool">
export type SlackDelivery = "delivered" | "permanent" | "transient" | "uncertain"
export type HarnessFeedbackSender = (group: SlackFeedbackGroup) => Promise<SlackDelivery>

const HEADING = "New harness issue"

function escapeSlack(value: string) {
  return value.replace(/\s+/gu, " ").replace(/@(?=channel\b|here\b|everyone\b)/giu, "@\u200b")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function message(group: SlackFeedbackGroup, webUrl: string) {
  const link = new URL("/admin/harness-feedback", webUrl)
  link.searchParams.set("group", group.id)
  const details = [
    escapeSlack(group.title),
    `Category: ${escapeSlack(harnessFeedbackCategoryLabel(group.category) ?? "Uncategorized")}`,
    `Surface: ${escapeSlack(harnessFeedbackSurfaceLabel(group.surface))}`,
    ...(group.tool ? [`Tool: ${escapeSlack(group.tool)}`] : []),
  ].join("\n")
  return {
    text: `${HEADING}\n${details}\n${escapeSlack(link.href)}`,
    mrkdwn: false, link_names: 0, parse: "none", unfurl_links: false, unfurl_media: false,
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

export function createHarnessFeedbackSlackSender(options: {
  webhookUrl: string; webUrl: string; fetch?: typeof fetch; timeoutMs?: number
}): HarnessFeedbackSender {
  const send = options.fetch ?? fetch
  return async (group) => {
    const signal = AbortSignal.timeout(options.timeoutMs ?? 5_000)
    let response: Response
    try {
      response = await send(options.webhookUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(message(group, options.webUrl)), signal, redirect: "manual",
      })
    } catch (error) {
      return !signal.aborted && isPreConnectError(error) ? "transient" : "uncertain"
    }
    void response.body?.cancel().catch(() => {})
    if (response.ok) return "delivered"
    if (response.status === 429 || response.status >= 500) return "transient"
    return "permanent"
  }
}
