import { escapeSlack, postToSlack, slackPayload } from "../harness-feedback/slack.js"

type SlackOptions = { webhookUrl: string; fetch?: typeof fetch }
type SlackCategory = "bug" | "enterprise"
type TriagedThread = { title: string; senderDomain: string | null; workspaceId: string; plainThreadId: string }
const headings: Record<SlackCategory, string> = { bug: "Possible product bug", enterprise: "Possible enterprise lead" }

export const postsToSlack = (category: string): category is SlackCategory => Object.hasOwn(headings, category)

export function sendTriagedThread(options: SlackOptions & { webUrl: string }, category: SlackCategory, thread: TriagedThread) {
  const heading = headings[category]
  const plainLink = `https://app.plain.com/workspace/${encodeURIComponent(thread.workspaceId)}/thread/${encodeURIComponent(thread.plainThreadId)}/`
  const adminLink = new URL("/admin/support-triage", options.webUrl).href
  const details = `${escapeSlack(thread.title)}\nSender domain: ${escapeSlack(thread.senderDomain ?? "Unknown")}`
  return postToSlack(options, {
    ...slackPayload(`${heading}\n${details}\n${escapeSlack(plainLink)}\n${escapeSlack(adminLink)}`),
    blocks: [
      { type: "header", text: { type: "plain_text", text: heading } },
      { type: "section", text: { type: "plain_text", text: details } },
      { type: "section", text: { type: "mrkdwn", verbatim: true, text: `<${escapeSlack(plainLink)}|Open in Plain> · <${escapeSlack(adminLink)}|Open in Den admin>` } },
    ],
  })
}

export function slackWebhookFor(category: SlackCategory, webhooks: { slackWebhookUrl: string | null; leadsSlackWebhookUrl: string | null }) {
  return category === "enterprise" ? webhooks.leadsSlackWebhookUrl ?? webhooks.slackWebhookUrl : webhooks.slackWebhookUrl
}

export function sendSupportTriageSlackTest(options: SlackOptions, destination: "bugs" | "leads" = "bugs") {
  const text = destination === "leads" ? "Test message from OpenWork support triage. Enterprise leads will post here." : "Test message from OpenWork support triage."
  return postToSlack(options, slackPayload(text))
}
