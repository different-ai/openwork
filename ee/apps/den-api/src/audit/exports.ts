import type { AuditEventEnvelope } from "@openwork/types/den/audit"

export function auditCsvCell(value: string | number | null) {
  const text = value === null ? "" : String(value)
  const unsafe = /^[\s\p{Cc}\p{Cf}]*[=+@-]/u.test(text) || /^[\s\p{Cc}\p{Cf}]*[\t\r\n]/u.test(text)
  const encoded = text.replace(/\\/g, "\\\\").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
  return `"${(unsafe ? "'" : "")}${encoded.replace(/"/g, '""')}"`
}

export function auditNdjson(events: AuditEventEnvelope[]) {
  return events.map((event) => JSON.stringify(event) + "\n").join("")
}

export function auditCsv(events: AuditEventEnvelope[]) {
  const header = ["schema_version", "event_id", "operation_id", "organization_id", "sequence", "operation_kind", "operation_scope", "operation_started_at", "initiating_actor_type", "initiating_actor_id", "origin", "origin_trust", "actor_type", "actor_id", "member_id", "credential_id", "action", "category", "event_outcome", "occurred_at", "recorded_at", "request_id", "resources_json", "changed_fields_json", "logical_bytes"]
  const rows = events.map((event) => [event.schemaVersion, event.id, event.operationId, event.organizationId, event.sequence, event.operation.kind, event.operation.scope, event.operation.startedAt, event.operation.initiatingActor.type, event.operation.initiatingActor.id, event.operation.origin, event.operation.originTrust, event.actor.type, event.actor.id, event.actor.memberId ?? null, event.actor.credentialId ?? null, event.action, event.category, event.outcome, event.occurredAt, event.recordedAt, event.requestId, JSON.stringify(event.resources), JSON.stringify(event.changes?.changedFields ?? []), event.logicalBytes])
  return [header, ...rows].map((row) => row.map(auditCsvCell).join(",") + "\r\n").join("")
}
