import { AuditLogError, type AuditDatabase } from "@openwork-ee/den-db/audit-log"
import { appLogger } from "../../observability/logger.js"
import { captureException } from "../../observability/runtime.js"
import { defaultAuditRegistry, type AuditRegistry } from "./registry.js"
import type { AuditCapture, AuditEventInput, AuditSinkContext, AuditTx } from "./types.js"

const logger = appLogger.child({ component: "audit_sink" })

/**
 * Atomic capture: open inside the caller's transaction, so the business change
 * rolls back if capture fails.
 *
 * Lock order: the sink takes the organization row FOR SHARE. Callers that lock
 * the organization row FOR UPDATE themselves (platform-admin handlers) open the
 * capture after their own FOR UPDATE. Every other caller opens it first, before
 * member, provider, audit state or policy locks. Never upgrade the share lock.
 */
export async function openAuditCapture(tx: AuditTx, ctx: AuditSinkContext, registry: AuditRegistry = defaultAuditRegistry): Promise<AuditCapture | null> {
  return registry.sink()(tx, ctx)
}

export type RecordAuditAfterCommitOptions = {
  database?: AuditDatabase
  registry?: AuditRegistry
}

/**
 * Post-commit capture in its own short transaction. A failure is logged and
 * reported, and never undoes or fails the change that already committed.
 */
export async function recordAuditAfterCommit(ctx: AuditSinkContext, event: AuditEventInput, options: RecordAuditAfterCommitOptions = {}): Promise<"recorded" | "skipped" | "failed"> {
  try {
    const database = options.database ?? (await import("../../db.js")).db
    return await database.transaction(async (tx) => {
      const capture = await openAuditCapture(tx, ctx, options.registry)
      if (!capture) return "skipped"
      return await capture.record(event) ? "recorded" : "skipped"
    })
  } catch (error) {
    const errorCode = error instanceof AuditLogError ? error.code : "audit_capture_error"
    logger.error("audit capture failed after commit", {
      event: "audit_capture_failed",
      organization_id: ctx.organizationId,
      kind: ctx.kind,
      action: event.action,
      error_code: errorCode,
    })
    captureException(error, { component: "audit_sink", event: "audit_capture_failed", kind: ctx.kind, action: event.action, error_code: errorCode })
    return "failed"
  }
}
