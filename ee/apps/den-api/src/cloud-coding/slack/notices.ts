import type { AuditTx } from "@openwork-ee/den-db/audit-log"
import type { CloudCodingTaskRow } from "../tasks.js"
import type { CloudCodingApprovalRow } from "../gateway/approvals.js"

export async function queueCloudCodingSlackNotice(_tx: AuditTx, _input: { approval: CloudCodingApprovalRow; task: CloudCodingTaskRow }): Promise<void> {
  return
}
