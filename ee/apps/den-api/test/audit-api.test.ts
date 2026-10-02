import assert from "node:assert/strict"
import { test } from "node:test"
import { createHmac } from "node:crypto"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { auditCaptureUpdateSchema, auditEventEnvelopeSchema, auditUsageResponseSchema } from "@openwork/types/den/audit"
import { AUDIT_CURSOR_TTL_MS, AuditReadError, auditFilterHash, readAuditCursor, signAuditCursor, type AuditCursor, type AuditCursorBinding } from "../src/audit/cursors.js"
import { auditCsv, auditCsvCell, auditNdjson } from "../src/audit/exports.js"
import { auditExportQuerySchema, auditOperationsQuerySchema, auditPageQuerySchema } from "../src/audit/queries.js"

const secret = "synthetic-audit-cursor-secret-not-production"
const now = Date.now()
function fixture(mode: AuditCursor["mode"] = "operations") {
  const operationId = createDenTypeId("auditOperation")
  const binding: AuditCursorBinding = { organizationId: createDenTypeId("organization"), mode, operationId: mode === "events" ? operationId : null, filterHash: auditFilterHash({ action: "provider.updated" }) }
  const value: AuditCursor = { version: 1, ...binding, watermark: 20, watermarkEventId: createDenTypeId("auditEvent"), removedEvents: 0, issuedAt: now, expiresAt: now + AUDIT_CURSOR_TTL_MS, position: { operationId, eventId: createDenTypeId("auditEvent"), sequence: 4, startedAt: new Date(now).toISOString() } }
  return { value, binding, token: signAuditCursor(value, secret) }
}
const errorCode = (code: string) => (error: unknown) => error instanceof AuditReadError && error.code === code

function rawToken(value: unknown, domain = "openwork.den.audit.cursor.v1\0") {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${payload}.${createHmac("sha256", secret).update(domain).update(payload).digest("base64url")}`
}

test("capture contract requires independent availability, opt-in and effective capture fields", () => {
  const usage = { entitlement: { enabled: false, source: "none" }, captureOn: false, captureAvailable: false, captureEnabled: false, policy: null, retainedOperations: 0, eventCount: 0, logicalBytes: 0, oldestAvailableAt: null, measuredAt: null, billing: "disabled", cleanup: "dry_run", drains: "not_configured" }
  assert.equal(auditUsageResponseSchema.safeParse(usage).success, true)
  for (const field of ["entitlement", "captureOn", "captureAvailable"]) assert.equal(auditUsageResponseSchema.safeParse(Object.fromEntries(Object.entries(usage).filter(([key]) => key !== field))).success, false)
  assert.deepEqual(auditCaptureUpdateSchema.parse({ captureOn: false, expectedRevision: 0 }), { captureOn: false, expectedRevision: 0 })
  for (const input of [{ captureOn: true }, { captureOn: "true", expectedRevision: 1 }, { captureOn: true, expectedRevision: -1 }, { captureOn: true, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { captureOn: true, expectedRevision: 1, entitlement: { enabled: true } }]) assert.equal(auditCaptureUpdateSchema.safeParse(input).success, false)
})

test("signed cursors round-trip and hashes ignore property ordering and undefined fields", () => {
  const f = fixture()
  assert.deepEqual(readAuditCursor(f.token, f.binding, secret, now), f.value)
  assert.equal(auditFilterHash({ origin: "api", action: "provider.updated", from: undefined }), auditFilterHash({ action: "provider.updated", origin: "api" }))
  assert.notEqual(auditFilterHash({ resourceId: "a" }), auditFilterHash({ resourceId: "b" }))
})

test("cursors reject cross-tenant, mode, operation, query and key substitution", () => {
  const f = fixture("events")
  for (const binding of [
    { ...f.binding, organizationId: createDenTypeId("organization") },
    { ...f.binding, mode: "operations", operationId: null } satisfies AuditCursorBinding,
    { ...f.binding, operationId: createDenTypeId("auditOperation") },
    { ...f.binding, filterHash: auditFilterHash({}) },
  ]) assert.throws(() => readAuditCursor(f.token, binding, secret, now), errorCode("audit_invalid_cursor"))
  assert.throws(() => readAuditCursor(f.token, f.binding, "different-secret", now), errorCode("audit_invalid_cursor"))
  const exported = fixture("export-csv")
  assert.throws(() => readAuditCursor(exported.token, { ...exported.binding, mode: "export-ndjson" }, secret, now), errorCode("audit_invalid_cursor"))
})

test("cursor expiry is exactly 24 hours and future-issued cursors are invalid", () => {
  const f = fixture()
  assert.equal(readAuditCursor(f.token, f.binding, secret, now + AUDIT_CURSOR_TTL_MS - 1).expiresAt, now + AUDIT_CURSOR_TTL_MS)
  assert.throws(() => readAuditCursor(f.token, f.binding, secret, now + AUDIT_CURSOR_TTL_MS), errorCode("audit_cursor_expired"))
  assert.throws(() => readAuditCursor(f.token, f.binding, secret, now - 1), errorCode("audit_invalid_cursor"))
})

test("malformed, noncanonical, oversized, tampered and wrong-domain cursors fail closed", () => {
  const f = fixture()
  for (const token of ["", "a.b", "a".repeat(4097), `${f.token}.extra`, ` ${f.token}`, f.token.replace(/.$/, "!"), rawToken(f.value, "session:"), rawToken({ ...f.value, injected: true }), rawToken({ ...f.value, watermark: Number.MAX_SAFE_INTEGER + 1 }), rawToken({ ...f.value, position: { ...f.value.position, sequence: 21 } }), rawToken({ ...f.value, expiresAt: now + 2 * AUDIT_CURSOR_TTL_MS }), rawToken({ ...f.value, organizationId: "malicious" })]) {
    assert.throws(() => readAuditCursor(token, f.binding, secret, now), errorCode("audit_invalid_cursor"))
  }
})

test("query validation bounds pages, rejects unknown controls and normalizes ISO dates", () => {
  assert.deepEqual(auditPageQuerySchema.parse({}), { limit: 50 })
  assert.equal(auditPageQuerySchema.parse({ limit: "100" }).limit, 100)
  for (const limit of ["0", "101", "-1", "1.5", "01", "1e2", "Infinity", " 5"]) assert.equal(auditPageQuerySchema.safeParse({ limit }).success, false)
  assert.equal(auditOperationsQuerySchema.safeParse({ organizationId: createDenTypeId("organization") }).success, false)
  assert.equal(auditOperationsQuerySchema.safeParse({ resourceType: "provider" }).success, false)
  assert.equal(auditOperationsQuerySchema.safeParse({ action: "provider.*" }).success, false)
  assert.equal(auditOperationsQuerySchema.safeParse({ outcome: "denied" }).success, false)
  assert.equal(auditOperationsQuerySchema.safeParse({ from: "2026-02-30" }).success, false)
  assert.equal(auditOperationsQuerySchema.safeParse({ from: "2026-02-02", to: "2026-01-01" }).success, false)
  assert.equal(auditOperationsQuerySchema.parse({ from: "2026-01-01T01:00:00+01:00" }).from, "2026-01-01T00:00:00.000Z")
  assert.equal(auditOperationsQuerySchema.parse({ to: "2026-01-02" }).to, "2026-01-02T00:00:00.000Z")
  assert.equal(auditExportQuerySchema.parse({}).format, "ndjson")
})

test("ID search is bounded exact text without coercion, normalization or controls for lists and exports", () => {
  for (const schema of [auditOperationsQuerySchema, auditExportQuerySchema]) {
    for (const searchId of ["x", "X".repeat(255), "CaseSensitive", " exact ", "literal%_id", "' OR 1=1 --"]) assert.equal(schema.parse({ searchId }).searchId, searchId)
    for (const searchId of ["", "x".repeat(256), 1, null, ["id"], { id: "id" }, "a\u0000b", "a\nb", "a\tb", "a\u007fb", "a\u0085b", "a\u009fb"]) assert.equal(schema.safeParse({ searchId }).success, false, JSON.stringify(searchId))
    assert.equal(schema.safeParse({ searchId: "id", resourceType: "provider" }).success, false)
    assert.equal(schema.safeParse({ searchId: "id", resourceId: "other", resourceType: "provider" }).success, true)
  }
})

test("ID search hashes bind exact text and coexist with the existing resource filter", () => {
  const hashes = [undefined, "Exact", "exact", "Exac", "Exact "].map((searchId) => auditFilterHash({ searchId }))
  assert.equal(new Set(hashes).size, hashes.length)
  assert.notEqual(auditFilterHash({ searchId: "Exact" }), auditFilterHash({ resourceId: "Exact" }))
  assert.notEqual(auditFilterHash({ searchId: "Exact" }), auditFilterHash({ searchId: "Exact", resourceId: "other" }))
  assert.equal(auditFilterHash({ searchId: "Exact", resourceId: "other" }), auditFilterHash({ resourceId: "other", searchId: "Exact" }))
  const f = fixture()
  const binding = { ...f.binding, filterHash: auditFilterHash({ searchId: "Exact" }) }
  const token = signAuditCursor({ ...f.value, ...binding }, secret)
  assert.equal(readAuditCursor(token, binding, secret, now).filterHash, binding.filterHash)
  for (const searchId of [undefined, "exact", "other"]) assert.throws(() => readAuditCursor(token, { ...binding, filterHash: auditFilterHash({ searchId }) }, secret, now), errorCode("audit_invalid_cursor"))
})

test("CSV quotes every cell and neutralizes formulas behind Unicode whitespace and controls", () => {
  for (const prefix of ["", " ", "\t", "\r", "\n", "\u0000", "\u00a0", "\u200b", "\ufeff", "\u0085"]) {
    for (const formula of ["=1+1", "+cmd", "-1", "@SUM(A1)"]) assert.ok(auditCsvCell(prefix + formula).startsWith('"\''), JSON.stringify(prefix + formula))
  }
  assert.equal(auditCsvCell('a,"b"'), '"a,""b"""')
  assert.equal(auditCsvCell("safe\nsecond\r\nrow"), '"safe\\u000asecond\\u000d\\u000arow"')
  assert.equal(auditCsvCell("\\u000a"), '"\\\\u000a"')
  assert.equal(auditCsvCell(null), '""')
  assert.equal(auditCsvCell(12), '"12"')
})

test("NDJSON retains a full strict envelope while CSV only includes documented summary fields", () => {
  const f = fixture()
  const event = auditEventEnvelopeSchema.parse({ schemaVersion: 1, id: f.value.position.eventId, organizationId: f.binding.organizationId, operationId: f.value.position.operationId, sequence: 1, operation: { kind: "audit.access", scope: "\t=1", origin: "api", originTrust: "authenticated", initiatingActor: { type: "unknown", id: null }, startedAt: new Date(now).toISOString() }, actor: { type: "unknown", id: null }, action: "audit.export.served", category: "access", outcome: "succeeded", occurredAt: new Date(now).toISOString(), recordedAt: new Date(now).toISOString(), requestId: null, resources: [], changes: { before: { name: "full-evidence-before" }, after: { name: "full-evidence-after" }, changedFields: ["name"] }, logicalBytes: 42 })
  assert.deepEqual(JSON.parse(auditNdjson([event])), event)
  assert.equal(auditNdjson([]), "")
  const csv = auditCsv([event])
  assert.equal(csv.split("\r\n").length, 3)
  assert.ok(csv.includes('"\'\\u0009=1"'))
  assert.ok(!csv.includes("full-evidence"))
  assert.ok(csv.startsWith('"schema_version","event_id"'))
  assert.equal(auditCsv([]).split("\r\n").length, 2)
})
