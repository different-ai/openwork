import { CLOUD_CODING_SLACK_ACTION_PREFIX } from "@openwork/types/den/cloud-coding"
import { env } from "../../env.js"
import type { CloudCodingApprovalRow, getCloudCodingPullRequest } from "../gateway/approvals.js"

function escape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function code(value: string, limit = 250) {
  const trimmed = value.length > limit ? `${value.slice(0, limit - 1)}…` : value
  return `\`${escape(trimmed.replace(/[\x00-\x1f\x7f]/g, " ").replaceAll("`", "ˋ"))}\``
}

export function slackRequester(userId: string) {
  return /^[UW][A-Z0-9]+$/.test(userId) ? `<@${userId}>` : "the requester"
}

const markdown = (text: string) => ({ type: "mrkdwn", text, verbatim: true })
const section = (text: string) => ({ type: "section", text: markdown(text) })
const context = (text: string) => ({ type: "context", elements: [markdown(text)] })
const tests = { passed: "Tests passed", failed: "Tests failed", not_run: "Tests not run" }

export function cloudCodingSlackMessage(approval: CloudCodingApprovalRow, requesterSlackUserId: string, pr: Awaited<ReturnType<typeof getCloudCodingPullRequest>> | null) {
  const repository = escape(approval.repositoryFullName)
  const requester = slackRequester(requesterSlackUserId)
  const link = context(`<${env.webUrl}/dashboard/cloud-coding/approvals/${approval.id}|Open in OpenWork>`)
  if (approval.status === "pending") {
    const { fileCount, files } = approval.summary
    const listed = files.slice(0, 5).map((file) => code(file.path, 72))
    const more = fileCount - listed.length
    const heading = `Push to ${repository}?`
    const changed = [`${fileCount} ${fileCount === 1 ? "file" : "files"} changed`, ...listed, ...(more > 0 ? [`and ${more} more`] : [])].join("\n")
    const fields = [`New branch: ${code(approval.branch)}`, changed, `Commit: ${code(approval.headSha.slice(0, 7))}`, tests[approval.summary.tests.status]].map(markdown)
    const button = (value: "allow_once" | "deny", label: string) => ({
      type: "button", text: { type: "plain_text", text: label }, action_id: `${CLOUD_CODING_SLACK_ACTION_PREFIX}${approval.id}:${value}`, value,
      ...(value === "allow_once" ? { style: "primary" } : {}),
    })
    return {
      text: `${heading} Review the requested push in this thread.`,
      blocks: [section(`*${heading}*`), { type: "section", fields }, section(`Nothing has been sent to GitHub yet. Only ${requester} can approve.`),
        { type: "actions", elements: [button("allow_once", "Approve"), button("deny", "Deny")] }, link],
    }
  }
  const state = {
    approved: `Approved by ${requester}. Pushing the branch…`,
    denied: `Denied by ${requester}. Nothing was pushed.`,
    pushed: pr ? `Approved by ${requester}. Pull request: <${escape(pr.url.replaceAll("|", "%7C"))}|${repository} #${pr.number}>` : `Approved by ${requester}. Pushing the branch…`,
    expired: "This request expired.",
    superseded: "Replaced by a newer request.",
  }[approval.status]
  return { text: state, blocks: [section(state), link] }
}
