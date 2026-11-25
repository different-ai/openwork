import type { PrivateValueFillReport } from "@openwork/types/den/private-value-fills"
import type { AuditChangeEventInput } from "../request-capture.js"
import { auditChangeEvent, auditText, organizationParent, targetResource } from "./snapshot.js"

const outcomes: Record<PrivateValueFillReport["result"], Pick<AuditChangeEventInput, "action" | "category" | "outcome" | "reasonCode">> = {
  filled: { action: "private_value.filled", category: "access", outcome: "succeeded" },
  declined: { action: "private_value.fill_declined", category: "access", outcome: "denied", reasonCode: "member_declined" },
  refused: { action: "private_value.fill_refused", category: "security", outcome: "denied", reasonCode: "organization_rule" },
}

export function privateValueFillEvent(organizationId: string, report: PrivateValueFillReport): AuditChangeEventInput | null {
  const { outcome, ...classification } = outcomes[report.result]
  const site = auditText(report.site)
  const event = auditChangeEvent({
    ...classification,
    before: null,
    after: { site, fields: [{ field: auditText(report.field), source: report.source, program: auditText(report.program) }] },
    resources: [targetResource("private_value_fill", report.id, site), organizationParent(organizationId)],
  })
  return event && { ...event, outcome, idempotencyKey: `private_value_fill:${report.id}` }
}
