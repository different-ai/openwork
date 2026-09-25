import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { typeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"

export const AUDIT_CURSOR_TTL_MS = 24 * 60 * 60 * 1000
const domain = "openwork.den.audit.cursor.v1\0"
const sequence = z.number().int().nonnegative().safe()
const positionSchema = z.object({
  operationId: typeId.schema("auditOperation"),
  eventId: typeId.schema("auditEvent"),
  sequence: sequence.positive(),
  startedAt: z.string().datetime(),
}).strict()
const cursorSchema = z.object({
  version: z.literal(1),
  organizationId: typeId.schema("organization"),
  mode: z.enum(["operations", "events", "export-ndjson", "export-csv"]),
  filterHash: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: typeId.schema("auditOperation").nullable(),
  watermark: sequence.positive(),
  watermarkEventId: typeId.schema("auditEvent"),
  removedEvents: sequence,
  position: positionSchema,
  issuedAt: sequence,
  expiresAt: sequence,
}).strict().refine((value) => value.position.sequence <= value.watermark
  && value.removedEvents <= value.watermark
  && value.expiresAt - value.issuedAt === AUDIT_CURSOR_TTL_MS
  && (value.mode === "events" ? value.operationId === value.position.operationId : value.operationId === null))

export type AuditCursor = z.infer<typeof cursorSchema>
export type AuditCursorBinding = Pick<AuditCursor, "organizationId" | "mode" | "filterHash" | "operationId">
export class AuditReadError extends Error {
  constructor(readonly code: "audit_invalid_query" | "audit_invalid_cursor" | "audit_cursor_expired" | "audit_history_unavailable" | "audit_operation_not_found" | "audit_storage_inconsistent") {
    super(code)
    this.name = "AuditReadError"
  }
  get status() {
    if (this.code === "audit_cursor_expired" || this.code === "audit_history_unavailable") return 410
    if (this.code === "audit_operation_not_found") return 404
    if (this.code === "audit_storage_inconsistent") return 503
    return 400
  }
}

export function auditFilterHash(filters: Record<string, unknown>) {
  const entries = Object.entries(filters).filter(([, value]) => value !== undefined).sort(([left], [right]) => left.localeCompare(right))
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex")
}

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(domain).update(payload).digest()
}

export function signAuditCursor(value: AuditCursor, secret: string) {
  const payload = Buffer.from(JSON.stringify(cursorSchema.parse(value))).toString("base64url")
  return `${payload}.${signature(payload, secret).toString("base64url")}`
}

export function readAuditCursor(token: string, binding: AuditCursorBinding, secret: string, now = Date.now()): AuditCursor {
  const invalid = () => new AuditReadError("audit_invalid_cursor")
  if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw invalid()
  const [payload, signed] = token.split(".")
  const received = Buffer.from(signed, "base64url")
  if (received.toString("base64url") !== signed || !timingSafeEqual(new Uint8Array(signature(payload, secret)), new Uint8Array(received))) throw invalid()
  const bytes = Buffer.from(payload, "base64url")
  if (bytes.toString("base64url") !== payload) throw invalid()
  let input: unknown
  try { input = JSON.parse(bytes.toString("utf8")) } catch { throw invalid() }
  const parsed = cursorSchema.safeParse(input)
  if (!parsed.success) throw invalid()
  const value = parsed.data
  if (value.organizationId !== binding.organizationId || value.mode !== binding.mode || value.filterHash !== binding.filterHash || value.operationId !== binding.operationId || value.issuedAt > now) throw invalid()
  if (value.expiresAt <= now) throw new AuditReadError("audit_cursor_expired")
  return value
}
