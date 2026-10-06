// Public surface of the Core audit sink (W0-P09). Core code and modules record
// audit events through these helpers and never import the auditLogs module.
// Importing this file also loads the legacy registrations (including the
// auditLogs sink), so scripts and jobs see the same sink as app.ts.
export { openAuditCapture, recordAuditAfterCommit, type RecordAuditAfterCommitOptions } from "./helpers.js"
export { ORGANIZATION_AUDIT_ACTIONS, ORGANIZATION_AUDIT_EVENT_TYPES, organizationRouteAuditContext, auditFreeText, platformAdminAuditContext, relatedAuditResource } from "./organization-events.js"
export { auditEventTypeFor, auditEventTypes, auditSink, createAuditRegistry, registerAuditEventTypes, registerAuditSink, type AuditRegistry } from "./registry.js"
export type * from "./types.js"
import "../hooks/index.js"
