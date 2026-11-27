import type { AuditTx } from "@openwork-ee/den-db/audit-log"
import type { CloudCodingGatewayRefusal } from "@openwork/types/den/cloud-coding"
import { appendAuditChanges, type AuditChangeCapture, type AuditChangeEventInput } from "../../audit/request-capture.js"

type GatewayAction = `cloud_coding.${"push.requested" | "push.approved" | "push.denied" | "push.completed" | "push.refused" | "pull_request.opened"}`
type Evidence = { repositoryFullName: string; branch?: string; headSha?: string; id?: string; number?: number }

export function recordGatewayEvent(tx: AuditTx, capture: AuditChangeCapture | null, action: GatewayAction, info: Evidence, reasonCode?: CloudCodingGatewayRefusal) {
  const resources: AuditChangeEventInput["resources"] = [{ type: "repository", id: info.repositoryFullName, relationship: "related" }]
  if (info.id) resources.push({ type: "cloud_coding_approval", id: info.id, relationship: "target" })
  if (info.number) resources.push({ type: "pull_request", id: `${info.repositoryFullName}#${info.number}`, relationship: "related" })
  const facts = { repositoryFullName: info.repositoryFullName, ...(info.branch ? { branch: info.branch } : {}), ...(info.headSha ? { headSha: info.headSha } : {}), ...(info.number ? { number: info.number } : {}) }
  return appendAuditChanges(tx, capture, [{ action, resources, ...(reasonCode ? { reasonCode, outcome: "denied" as const } : {}), changes: { before: null, after: facts, changedFields: Object.keys(facts) } }])
}
