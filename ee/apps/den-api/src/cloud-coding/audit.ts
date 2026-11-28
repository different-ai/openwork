import { appendAuditChanges, auditChangeCapture, type AuditChangeEventInput } from "../audit/request-capture.js"
import type { AuditTx } from "@openwork-ee/den-db/audit-log"
import type { Context } from "hono"
import type { CloudCodingMemberScope } from "./links.js"

type Action = `cloud_coding.${"github.connected" | "github.disconnected" | "settings.updated" | "account.linked" | "account.unlinked" | "link_reminder.sent" | "admin_request.sent"}`
type Facts = { githubLogin?: string; installationId?: number; enabled?: boolean; orgWide?: boolean }

export function cloudCodingEvent(action: Action, organizationId: string, memberId?: string, facts?: Facts): AuditChangeEventInput {
  const resources: AuditChangeEventInput["resources"] = [{ type: "organization", id: organizationId, relationship: memberId ? "parent" : "target" }]
  if (memberId) resources.push({ type: "member", id: memberId, relationship: "target" })
  return { action, resources, ...(facts ? { changes: { before: null, after: facts, changedFields: Object.keys(facts) } } : {}) }
}

export function recordCloudCodingEvent(c: Context, tx: AuditTx, action: Action, input: CloudCodingMemberScope, facts?: Facts) {
  return appendAuditChanges(tx, auditChangeCapture(c), [cloudCodingEvent(action, input.organizationId, input.memberId, facts)])
}

export function cloudCodingInstallationAudit(c: Context, memberId?: string) {
  const capture = auditChangeCapture(c)
  const append = (action: Action) => (tx: AuditTx, row: { organizationId: string; githubInstallationId: number; accountLogin: string }) => appendAuditChanges(tx, capture, [
    cloudCodingEvent(action, row.organizationId, memberId, { installationId: row.githubInstallationId, githubLogin: row.accountLogin }),
  ])
  return { onConnected: append("cloud_coding.github.connected"), onDisconnected: append("cloud_coding.github.disconnected") }
}
