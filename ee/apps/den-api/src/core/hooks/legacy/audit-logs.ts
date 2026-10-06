import { createAuditLogsSink } from "../../../audit/sink.js"
import { ORGANIZATION_AUDIT_EVENT_TYPES } from "../../audit/organization-events.js"
import { auditEventTypeFor, registerAuditEventTypes, registerAuditSink } from "../../audit/registry.js"

// Future owner: auditLogs (the sink) plus each declaration's owner module
// (W0-04 manifest `auditEvents`). M-auditLogs moves this into its manifest.

registerAuditEventTypes(ORGANIZATION_AUDIT_EVENT_TYPES)
registerAuditSink(createAuditLogsSink({ eventTypeFor: auditEventTypeFor }))
