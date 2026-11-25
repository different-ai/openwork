import { escapeSlack, postToSlack, slackPayload } from "../harness-feedback/slack.js"

type SlackOptions = { webhookUrl: string; fetch?: typeof fetch }
type EnterpriseLead = { title: string; senderDomain: string | null; workspaceId: string; plainThreadId: string }
const heading = "Possible enterprise lead"

export function sendEnterpriseLead(options: SlackOptions & { webUrl: string }, lead: EnterpriseLead) {
  const plainLink = `https://app.plain.com/workspace/${encodeURIComponent(lead.workspaceId)}/thread/${encodeURIComponent(lead.plainThreadId)}/`
  const adminLink = new URL("/admin/support-triage", options.webUrl).href
  const details = `${escapeSlack(lead.title)}\nSender domain: ${escapeSlack(lead.senderDomain ?? "Unknown")}`
  return postToSlack(options, {
    ...slackPayload(`${heading}\n${details}\n${escapeSlack(plainLink)}\n${escapeSlack(adminLink)}`),
    blocks: [
      { type: "header", text: { type: "plain_text", text: heading } },
      { type: "section", text: { type: "plain_text", text: details } },
      { type: "section", text: { type: "mrkdwn", verbatim: true, text: `<${escapeSlack(plainLink)}|Open in Plain> · <${escapeSlack(adminLink)}|Open in Den admin>` } },
    ],
  })
}

export function sendSupportTriageSlackTest(options: SlackOptions) {
  return postToSlack(options, slackPayload("Test message from OpenWork support triage."))
}
