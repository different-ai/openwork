import type { AuditActor, AuditCategory, AuditEventInput, AuditKind, AuditTx } from "@openwork-ee/den-db/audit-log"

export type { AuditActor, AuditCategory, AuditEventInput, AuditKind, AuditTx }

export type AuditSinkOrigin = "api" | "mcp" | "platform_admin" | "scheduler" | "webhook" | "cloud_ui"

export type AuditSinkContext = {
  organizationId: string
  actor: AuditActor
  origin: AuditSinkOrigin
  requestId: string | null
  correlationId?: string | null
  kind: AuditKind
  /** Resource id the operation is about. */
  scope: string
  workflowStep?: string
  workflowStepScope?: string
}

export type AuditCapture = {
  /**
   * Append within the transaction the capture was opened in. Returns false when
   * the policy does not select the event's category. Throws AuditLogError on a
   * policy change or invalid evidence.
   */
  record(event: AuditEventInput): Promise<boolean>
}

/**
 * Returns null when audit capture is not effective for the organization (the
 * owning module is off, capture is disabled, or no enabled policy exists).
 */
export type AuditSink = (tx: AuditTx, ctx: AuditSinkContext) => Promise<AuditCapture | null>

/** What a kind may record. W0-04's manifest `auditEvents` field is this type. */
export type AuditEventTypeDeclaration = {
  kind: AuditKind
  actions: readonly string[]
  categories: readonly AuditCategory[]
  resources: readonly string[]
  /** Module id, or "core". */
  owner: string
}
