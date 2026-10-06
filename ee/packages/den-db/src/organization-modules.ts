import { and, eq, getTableColumns, sql } from "drizzle-orm"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { createDenDb } from "./client"
import { organizationModulesSchema, type OrganizationModules } from "./organization-modules-contract"
import { OrganizationTable } from "./schema/org"

export {
  entitlementSnapshotSchema,
  organizationModulesSchema,
  type EntitlementSnapshot,
  type OrganizationModules,
} from "./organization-modules-contract"

/**
 * Typed access to `organization.modules` (discovery §7.2, plan W0-02).
 *
 * Every write goes through this module: it validates the document, bumps
 * `revision` by exactly 1 and uses a compare-and-set on the previous revision,
 * so no row lock is held across unrelated work. The helpers never open their
 * own transaction; pass a transaction handle to combine a write with other
 * statements. A NULL column means "no document yet": revision 0, no opt-outs,
 * no Cloud snapshot, and legacy kill switches still read from metadata.
 */

type Db = ReturnType<typeof createDenDb>["db"]
export type OrganizationModulesExecutor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0]

export const ORGANIZATION_MODULES_MAX_BYTES = 65_536

export type ParsedOrganizationModules =
  | { status: "absent"; doc: null; revision: 0 }
  | { status: "valid"; doc: OrganizationModules; revision: number }
  | { status: "invalid"; doc: null; revision: number | null; issues: string[] }

export type ModulesWriteKind = "toggle" | "entitlement" | "legacy"

export type CompareAndSetResult =
  | { ok: true; doc: OrganizationModules }
  | { ok: false; reason: "conflict"; currentRevision: number | null }
  | { ok: false; reason: "not_found" }

export type UpdateOrganizationModulesResult =
  | { ok: true; doc: OrganizationModules; unchanged: boolean; attempts: number }
  | { ok: false; reason: "conflict"; currentRevision: number | null; attempts: number }
  | { ok: false; reason: "not_found"; attempts: number }

export class OrganizationModulesTooLargeError extends Error {
  readonly bytes: number
  constructor(bytes: number) {
    super(`organization.modules document is ${bytes} bytes; the limit is ${ORGANIZATION_MODULES_MAX_BYTES}.`)
    this.name = "OrganizationModulesTooLargeError"
    this.bytes = bytes
  }
}

export class OrganizationModulesCorruptError extends Error {
  readonly organizationId: string
  readonly issues: string[]
  constructor(organizationId: string, issues: string[]) {
    super(`organization.modules for ${organizationId} is invalid and must be repaired before it can be written.`)
    this.name = "OrganizationModulesCorruptError"
    this.organizationId = organizationId
    this.issues = issues
  }
}

export class OrganizationModulesWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OrganizationModulesWriteError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

type DecodedColumn = { ok: true; value: unknown } | { ok: false; issue: string }

/** mysql2 returns JSON columns as objects; PlanetScale may return the JSON text. */
function decodeColumn(value: unknown): DecodedColumn {
  if (value === null || value === undefined) return { ok: true, value: null }
  if (typeof value !== "string") return { ok: true, value }
  try {
    const parsed: unknown = JSON.parse(value)
    return { ok: true, value: parsed }
  } catch {
    return { ok: false, issue: "(root): stored value is not valid JSON" }
  }
}

function revisionOf(value: unknown): number | null {
  if (!isRecord(value)) return null
  const revision = value.revision
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : null
}

/** Parses the raw column value from either driver. Never throws. */
export function parseOrganizationModulesColumn(value: unknown): ParsedOrganizationModules {
  const decoded = decodeColumn(value)
  if (!decoded.ok) return { status: "invalid", doc: null, revision: null, issues: [decoded.issue] }
  if (decoded.value === null) return { status: "absent", doc: null, revision: 0 }
  const parsed = organizationModulesSchema.safeParse(decoded.value)
  if (!parsed.success) {
    return {
      status: "invalid",
      doc: null,
      revision: revisionOf(decoded.value),
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    }
  }
  return { status: "valid", doc: parsed.data, revision: parsed.data.revision }
}

/** Cheap revision read without a full schema parse: 0 for NULL, null when unreadable. */
export function readOrganizationModulesRevision(value: unknown): number | null {
  const decoded = decodeColumn(value)
  if (!decoded.ok) return null
  if (decoded.value === null) return 0
  return revisionOf(decoded.value)
}

/**
 * Dedupes and sorts `disabled`, keeping unknown strings (forward compatibility
 * after a downgrade). Validating which ids may be toggled is the caller's job.
 * TODO(W0-01): order by `MODULE_IDS` with unknown ids last.
 */
export function normalizeDisabledModules(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort()
}

export function emptyOrganizationModules(now: Date): OrganizationModules {
  return { schemaVersion: 1, revision: 0, disabled: [], updatedAt: now.toISOString(), updatedBy: null }
}

/** Explicit select for code that needs the module inputs of an org row. */
export const organizationModuleStateColumns = {
  id: OrganizationTable.id,
  metadata: OrganizationTable.metadata,
  modules: OrganizationTable.modules,
}

const { modules: _storedModules, ...columnsWithoutModules } = getTableColumns(OrganizationTable)

/**
 * Every organization column except `modules`. Use it for selects whose rows
 * are returned to clients, so the stored document can never leak.
 */
export const organizationColumnsWithoutModules = columnsWithoutModules

/** Shared driver-agnostic row count: mysql2 reports `affectedRows`, PlanetScale `rowsAffected`. */
export function affectedRows(result: unknown): number {
  if (Array.isArray(result)) return affectedRows(result[0])
  if (typeof result !== "object" || result === null) return 0
  if ("rowsAffected" in result && typeof result.rowsAffected === "number") return result.rowsAffected
  if ("affectedRows" in result && typeof result.affectedRows === "number") return result.affectedRows
  return 0
}

function organizationIdOf(organizationId: string) {
  return normalizeDenTypeId("organization", organizationId)
}

/** Reads and parses one org's document. Resolves `null` when the org does not exist. */
export async function readOrganizationModules(
  executor: OrganizationModulesExecutor,
  organizationId: string,
  options: { lock?: "share" | "update" } = {},
): Promise<ParsedOrganizationModules | null> {
  const query = executor
    .select({ modules: OrganizationTable.modules })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationIdOf(organizationId)))
    .limit(1)
  const rows = options.lock ? await query.for(options.lock) : await query
  const row = rows[0]
  return row ? parseOrganizationModulesColumn(row.modules) : null
}

function validateNextDocument(next: OrganizationModules, expectedRevision: number): OrganizationModules {
  const parsed = organizationModulesSchema.safeParse({ ...next, disabled: normalizeDisabledModules(next.disabled) })
  if (!parsed.success) {
    throw new OrganizationModulesWriteError(`Invalid organization.modules document: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`)
  }
  if (parsed.data.revision !== expectedRevision + 1) {
    throw new OrganizationModulesWriteError(`organization.modules revision must be ${expectedRevision + 1}, got ${parsed.data.revision}.`)
  }
  const bytes = Buffer.byteLength(JSON.stringify(parsed.data), "utf8")
  if (bytes > ORGANIZATION_MODULES_MAX_BYTES) throw new OrganizationModulesTooLargeError(bytes)
  return parsed.data
}

function revisionGuard(expectedRevision: number) {
  if (expectedRevision === 0) {
    return sql`(${OrganizationTable.modules} IS NULL OR JSON_EXTRACT(${OrganizationTable.modules}, '$.revision') = 0)`
  }
  return sql`JSON_EXTRACT(${OrganizationTable.modules}, '$.revision') = ${expectedRevision}`
}

async function conflictOrNotFound(executor: OrganizationModulesExecutor, organizationId: string): Promise<CompareAndSetResult> {
  const rows = await executor
    .select({ modules: OrganizationTable.modules })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationIdOf(organizationId)))
    .limit(1)
  const row = rows[0]
  if (!row) return { ok: false, reason: "not_found" }
  return { ok: false, reason: "conflict", currentRevision: readOrganizationModulesRevision(row.modules) }
}

/**
 * One `UPDATE … WHERE id = ? AND <revision guard>`; no lock is held.
 * `expectedRevision` 0 means the column is NULL. `next.revision` must be
 * `expectedRevision + 1`. Only `toggle` writes bump `organization.updated_at`;
 * entitlement and legacy writes keep it, because they are system writes.
 */
export async function compareAndSetOrganizationModules(
  executor: OrganizationModulesExecutor,
  input: { organizationId: string; expectedRevision: number; next: OrganizationModules; kind: ModulesWriteKind },
): Promise<CompareAndSetResult> {
  const next = validateNextDocument(input.next, input.expectedRevision)
  const result = await executor
    .update(OrganizationTable)
    .set(input.kind === "toggle" ? { modules: next } : { modules: next, updatedAt: sql`${OrganizationTable.updatedAt}` })
    .where(and(eq(OrganizationTable.id, organizationIdOf(input.organizationId)), revisionGuard(input.expectedRevision)))
  if (affectedRows(result) === 1) return { ok: true, doc: next }
  return conflictOrNotFound(executor, input.organizationId)
}

function sameContent(a: OrganizationModules, b: OrganizationModules): boolean {
  return JSON.stringify([normalizeDisabledModules(a.disabled), a.entitlement ?? null])
    === JSON.stringify([normalizeDisabledModules(b.disabled), b.entitlement ?? null])
}

/**
 * Read → mutate → compare-and-set, retrying on conflict. `mutate` receives a
 * copy of the current document (an empty one for NULL) and returns the desired
 * document, or `null` for "no change". The helper owns `schemaVersion`,
 * `revision`, `updatedAt` and `updatedBy`: only `toggle` writes set
 * `updatedAt = now` and `updatedBy = actorMemberId`. A stored document that
 * fails validation is never overwritten here (`OrganizationModulesCorruptError`);
 * repair it with `repairOrganizationModules`.
 *
 * Retries use a locking read, which is a current read, so a retry inside a
 * REPEATABLE READ transaction sees the competing write instead of its snapshot.
 */
export async function updateOrganizationModules(
  executor: OrganizationModulesExecutor,
  input: {
    organizationId: string
    kind: ModulesWriteKind
    actorMemberId: string | null
    mutate: (current: OrganizationModules) => OrganizationModules | null | Promise<OrganizationModules | null>
    now?: Date
    maxAttempts?: number
  },
): Promise<UpdateOrganizationModulesResult> {
  const now = input.now ?? new Date()
  const maxAttempts = Math.max(1, input.maxAttempts ?? 3)
  let lastConflict: number | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const parsed = await readOrganizationModules(executor, input.organizationId, attempt > 1 ? { lock: "update" } : {})
    if (!parsed) return { ok: false, reason: "not_found", attempts: attempt }
    if (parsed.status === "invalid") throw new OrganizationModulesCorruptError(input.organizationId, parsed.issues)
    const current = parsed.status === "valid" ? parsed.doc : emptyOrganizationModules(now)
    const mutated = await input.mutate(structuredClone(current))
    if (mutated === null || sameContent(mutated, current)) return { ok: true, doc: current, unchanged: true, attempts: attempt }
    const next: OrganizationModules = {
      ...mutated,
      schemaVersion: 1,
      revision: parsed.revision + 1,
      disabled: normalizeDisabledModules(mutated.disabled),
      updatedAt: input.kind === "toggle" ? now.toISOString() : current.updatedAt,
      updatedBy: input.kind === "toggle" ? input.actorMemberId : current.updatedBy,
    }
    const result = await compareAndSetOrganizationModules(executor, {
      organizationId: input.organizationId,
      expectedRevision: parsed.revision,
      next,
      kind: input.kind,
    })
    if (result.ok) return { ok: true, doc: result.doc, unchanged: false, attempts: attempt }
    if (result.reason === "not_found") return { ok: false, reason: "not_found", attempts: attempt }
    lastConflict = result.currentRevision
  }
  return { ok: false, reason: "conflict", currentRevision: lastConflict, attempts: maxAttempts }
}

/**
 * Operator repair for a document that fails validation: replaces it with
 * `next` only if the stored value still equals `observed` (the raw column value
 * that was read). `next.revision` must be one more than the observed revision
 * (or 1 when it is unreadable). Not for normal writes.
 */
export async function repairOrganizationModules(
  executor: OrganizationModulesExecutor,
  input: { organizationId: string; observed: unknown; next: OrganizationModules },
): Promise<CompareAndSetResult> {
  const decoded = decodeColumn(input.observed)
  if (!decoded.ok || decoded.value === null) {
    throw new OrganizationModulesWriteError("repairOrganizationModules needs the stored JSON value that failed validation.")
  }
  const observedRevision = revisionOf(decoded.value) ?? 0
  const next = validateNextDocument(input.next, observedRevision)
  const result = await executor
    .update(OrganizationTable)
    .set({ modules: next, updatedAt: sql`${OrganizationTable.updatedAt}` })
    .where(and(
      eq(OrganizationTable.id, organizationIdOf(input.organizationId)),
      sql`${OrganizationTable.modules} = CAST(${JSON.stringify(decoded.value)} AS JSON)`,
    ))
  if (affectedRows(result) === 1) return { ok: true, doc: next }
  return conflictOrNotFound(executor, input.organizationId)
}
