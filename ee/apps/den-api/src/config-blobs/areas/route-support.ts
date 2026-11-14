/**
 * Shared helpers for the config-blob adapters that apply through existing
 * route handlers (connectors, BYOK providers, desktop policies, collections).
 *
 * Those handlers take a Hono context (`c.json`, `c.get("organizationContext")`,
 * `c.get("session")`). `configRouteContext` builds a real Hono `Context` for
 * the applying member, so the handler runs its own validation, permission
 * checks and side effects exactly as for a dashboard request, and the adapter
 * reads its `Response`.
 *
 * Audit: generic request capture (the route middleware) does not run here.
 * The service runs the whole apply inside runWithAuditJobChangeCapture
 * (config-blobs/service.ts → audit/request-capture.ts): `auditChangeCapture(c)`
 * for this synthetic context, and `currentAuditChangeCapture()`, return the
 * apply's `tenant_job` operation capture, so every domain change event the
 * handlers emit joins that one operation (jobRunId = change request id).
 * Handlers that only record request evidence leave nothing per item; the
 * apply report and before-snapshot cover them.
 */
import { randomUUID } from "node:crypto"
import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, InvitationTable, MemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  configRefSchema,
  configSecretSchema,
  type ConfigApplyStep,
  type ConfigFieldChange,
  type ConfigRef,
  type ResolvedConfigSecret,
} from "@openwork/types/den/config-blobs"
import { Context } from "hono"
import { z } from "zod"
import { getOrganizationContextForUser, type OrganizationContext } from "../../orgs.js"
import type { OrgRouteVariables } from "../../routes/org/shared.js"
import { ConfigApplyItemError, type ConfigApplyOp, type ConfigApplyResult, type ConfigAreaContext, type ConfigDb, type ConfigPreflightResult } from "../area.js"

export type JsonObject = { [key: string]: unknown }

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A failed apply step. `code` is the route's error code when it came from one. */
export class ConfigApplyError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number, readonly field?: string) {
    super(message)
    this.name = "ConfigApplyError"
  }
}

// ---------------------------------------------------------------------------
// Field changes and apply steps

/** Whether `path` is `prefix` or lies under it ("models[id=x].name" is under "models"). */
export function pathUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`)
}

/** Whether any change (or new secret value) touches one of `prefixes`, either above or below it. */
export function touches(changes: readonly ConfigFieldChange[], ...prefixes: string[]): boolean {
  return changes.some((change) => prefixes.some((prefix) => pathUnder(change.path, prefix) || pathUnder(prefix, change.path)))
}

/** The changes of an op (empty for creates and deletes). */
export function opChanges(op: ConfigApplyOp): ConfigFieldChange[] {
  return op.kind === "update" ? op.changes : []
}

/** Changes plus the secret paths of an update, as one list of touched paths. */
export function opTouched(op: ConfigApplyOp): ConfigFieldChange[] {
  if (op.kind !== "update") return []
  return [...op.changes, ...op.secretPaths.map((path) => ({ path }))]
}

function errorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  if ("code" in error && typeof error.code === "string" && error.code) return error.code
  if ("error" in error && typeof error.error === "string" && error.error) return error.error
  return null
}

function errorStatus(error: unknown): number | undefined {
  if (!(error instanceof Error) || !("status" in error)) return undefined
  return typeof error.status === "number" ? error.status : undefined
}

/**
 * Any error from an apply turned into a `ConfigApplyItemError`: route and
 * service errors keep their code, status and message; `where` names the write
 * that failed. An error that already is one keeps its own step and field.
 */
export function configItemError(error: unknown, stepsDone: readonly ConfigApplyStep[], where: { step?: ConfigApplyStep; field?: string } = {}): ConfigApplyItemError {
  if (error instanceof ConfigApplyItemError) {
    if (error.stepsDone.length > 0 || stepsDone.length === 0) return error
    return new ConfigApplyItemError({ ...error.failure, step: error.failure.step ?? where.step, field: error.failure.field ?? where.field }, [...stepsDone])
  }
  const field = error instanceof ConfigApplyError && error.field ? error.field : where.field
  const status = errorStatus(error)
  return new ConfigApplyItemError({
    code: errorCode(error) ?? "apply_failed",
    message: error instanceof Error ? error.message : String(error),
    ...(field ? { field } : {}),
    ...(where.step ? { step: where.step } : {}),
    ...(status !== undefined ? { status } : {}),
  }, [...stepsDone])
}

/** The ConfigApplyItemError for a failed route response (code, status and message from its body). */
export async function routeFailure(response: Response, action: string, stepsDone: readonly ConfigApplyStep[] = [], where: { step?: ConfigApplyStep; field?: string } = {}): Promise<ConfigApplyItemError> {
  try {
    await expectRouteOk(response, action)
    return configItemError(new ConfigApplyError("request_failed", `${action} failed (${response.status}).`, response.status), stepsDone, where)
  } catch (error) {
    return configItemError(error, stepsDone, where)
  }
}

/** The spec field a step target names: "models[gpt-5]" → "models", "access.teams" → "access.teams". */
function stepField(target: string): string {
  const bracket = target.indexOf("[")
  return bracket >= 0 ? target.slice(0, bracket) : target
}

/**
 * The writes of one item, in order. `run` performs a write and records it; a
 * failing write throws ConfigApplyItemError naming it, with the steps already done.
 */
export class ConfigStepLog {
  readonly steps: ConfigApplyStep[] = []

  async run<T>(step: ConfigApplyStep, write: () => Promise<T>, field?: string): Promise<T> {
    let result: T
    try {
      result = await write()
    } catch (error) {
      throw configItemError(error, this.steps, { step, field: field ?? stepField(step.target) })
    }
    this.steps.push(step)
    return result
  }

  add(...steps: ConfigApplyStep[]) {
    this.steps.push(...steps)
  }
}

/** Runs an adapter's apply with a step log: steps are returned, and any error becomes a ConfigApplyItemError with them. */
export async function applyWithSteps(apply: (log: ConfigStepLog) => Promise<Omit<ConfigApplyResult, "steps">>): Promise<ConfigApplyResult> {
  const log = new ConfigStepLog()
  try {
    const result = await apply(log)
    return { ...result, steps: [...log.steps] }
  } catch (error) {
    throw configItemError(error, log.steps)
  }
}

/** A step for set-valued fields: one `add` / `remove` step per element. */
export function setSteps(target: string, added: readonly string[], removed: readonly string[]): ConfigApplyStep[] {
  return [
    ...added.map((detail): ConfigApplyStep => ({ action: "add", target, detail })),
    ...removed.map((detail): ConfigApplyStep => ({ action: "remove", target, detail })),
  ]
}

// ---------------------------------------------------------------------------
// Running route handlers outside a request

/** Session id of the synthetic session an apply runs under. Not `mcp_internal`: no agent-only restrictions apply. */
export const CONFIG_APPLY_SESSION_ID = "config_blob_apply"

export type ConfigRouteEnv = { Variables: OrgRouteVariables }

export type ConfigRouteContext = {
  c: Context<ConfigRouteEnv>
  payload: OrganizationContext
  requestId: string
}

/**
 * A Hono context for the applying member. The session counts as freshly
 * signed in, because approving was the step-up:
 * - approving or applying from the dashboard needs a recent sign-in
 *   (routes/org/config-blobs.ts → `requireApprovalStepUp`), whatever the
 *   areas; a config token approves without one (D3: it has no session);
 * - the worker only applies while the last approval is under 24 hours old
 *   (service.ts → `CONFIG_APPROVAL_MAX_AGE_MS`); older, the request goes
 *   back to review with its approvals dropped ("approval expired").
 * Using the approver's real sign-in time instead would make every apply
 * queued a few minutes after approval fail the handlers' own fresh-session
 * checks.
 */
export async function configRouteContext(ctx: ConfigAreaContext): Promise<ConfigRouteContext> {
  const userId = normalizeDenTypeId("user", ctx.actor.userId)
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const payload = await getOrganizationContextForUser({ userId, organizationId })
  if (!payload || payload.currentMember.id !== ctx.actor.memberId) {
    throw new ConfigApplyError("actor_not_member", "The person applying this change is no longer a member of the organization.", 403)
  }
  const now = new Date()
  const c = new Context<ConfigRouteEnv>(new Request("http://config-blobs.invalid/apply"))
  c.set("organizationContext", payload)
  c.set("apiKey", null)
  c.set("session", {
    id: CONFIG_APPLY_SESSION_ID,
    token: CONFIG_APPLY_SESSION_ID,
    userId,
    activeOrganizationId: organizationId,
    activeTeamId: null,
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    updatedAt: now,
    ipAddress: null,
    userAgent: null,
  })
  return { c, payload, requestId: `config-blob-${randomUUID()}` }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const raw = await response.text()
  if (!raw.trim()) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed
  } catch {
    return raw
  }
}

/** The JSON body of a successful route response; throws ConfigApplyError with the route's error otherwise. */
export async function expectRouteOk(response: Response, action: string): Promise<JsonObject> {
  const body = await readResponseBody(response)
  if (response.status < 300) return isJsonObject(body) ? body : {}
  const code = isJsonObject(body) && typeof body.error === "string" ? body.error : "request_failed"
  const message = isJsonObject(body) && typeof body.message === "string" && body.message.trim() ? body.message : null
  throw new ConfigApplyError(code, routeErrorMessage(action, message, response.status), response.status)
}

/**
 * A failed route's message, said once: `Create "Docs": <message>`, or the
 * message alone when it already names what was acted on (`Could not validate
 * "Docs": …`), or `Create "Docs" failed (500).` when the route gave none.
 */
export function routeErrorMessage(action: string, message: string | null, status: number): string {
  if (!message) return `${action} failed (${status}).`
  const subject = actionSubject(action)
  return subject && message.includes(subject) ? message : `${action}: ${message}`
}

/** What an action label acts on: the quoted name (`Update "Docs"` → `Docs`), else what follows the verb. */
function actionSubject(action: string): string | null {
  const quoted = /"([^"]+)"/.exec(action)
  if (quoted?.[1]) return quoted[1]
  const rest = action.slice(action.indexOf(" ") + 1).trim()
  return action.includes(" ") && rest ? rest : null
}

export function stringField(body: JsonObject, ...path: string[]): string {
  let current: unknown = body
  for (const key of path) current = isJsonObject(current) ? current[key] : undefined
  if (typeof current !== "string" || !current) throw new ConfigApplyError("unexpected_response", `Missing ${path.join(".")} in the response.`)
  return current
}

// ---------------------------------------------------------------------------
// Spec shapes

export const specRefSchema = configRefSchema
export const specSecretSchema = configSecretSchema

/** Team and people references, the way every area with grants exports them. */
export const specAudienceSchema = z.object({
  teams: z.array(specRefSchema).max(500),
  members: z.array(specRefSchema).max(500),
}).strict()

export function teamRef(teamId: string, name: string | null | undefined): ConfigRef {
  return name ? { $ref: `members.teams/${teamId}`, name } : { $ref: `members.teams/${teamId}` }
}

export function personRef(email: string): ConfigRef {
  return { $ref: `people/${email}` }
}

export function secretPlaceholder(area: string, itemId: string, field: string, set: boolean) {
  return { $secret: `${area}/${itemId}/${field}`, set }
}

/**
 * Local ids of resolved references. The engine adds `id` to every `$ref` it
 * resolved and removes the ones the admin dropped, so a ref without `id` here
 * is a bug upstream: refuse rather than silently narrow access.
 */
export function resolvedRefIds(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ConfigApplyError("invalid_spec", `${label} must be a list.`)
  return value.map((entry) => {
    if (isJsonObject(entry) && typeof entry.id === "string" && entry.id) return entry.id
    const ref = isJsonObject(entry) && typeof entry.$ref === "string" ? entry.$ref : "?"
    throw new ConfigApplyError("ref_unresolved", `${label}: reference ${ref} was not resolved.`)
  })
}

/** The decision for one secret field at apply time. A raw `keep`/`unset` placeholder is accepted too. */
export function resolvedSecret(value: unknown, label: string): ResolvedConfigSecret | null {
  if (value === undefined || value === null) return null
  if (!isJsonObject(value) || typeof value.$secret !== "string") {
    throw new ConfigApplyError("invalid_spec", `${label} must be a secret placeholder.`)
  }
  const path = value.$secret
  if (value.decision === "keep" || value.keep === true) return { $secret: path, decision: "keep" }
  if (value.decision === "unset" || value.unset === true) return { $secret: path, decision: "unset" }
  if (value.decision === "value" && typeof value.value === "string") return { $secret: path, decision: "value", value: value.value }
  throw new ConfigApplyError("needs_input", `${label} has no decision (keep, value or unset).`)
}

/** The new value to write, `undefined` to keep the stored one, `null` to clear it. */
export function secretWrite(secret: ResolvedConfigSecret | null): string | null | undefined {
  if (!secret || secret.decision === "keep") return undefined
  if (secret.decision === "unset") return null
  return secret.value
}

/** Whether a placeholder says a value is stored (`{ $secret, set: true }`). */
export function secretIsSet(value: unknown): boolean {
  return isJsonObject(value) && value.set === true
}

/**
 * Irreversible effects of one secret decision, for `irreversible(op)`: a new
 * value overwrites the stored one, "unset" deletes it. Never throws: a
 * placeholder without a decision (not resolved yet) has no effect to report.
 * `previous` is the placeholder the target exported (whether a value is stored).
 */
export function secretEffects(value: unknown, label: string, previous?: unknown): string[] {
  if (!isJsonObject(value)) return []
  const stored = previous === undefined || secretIsSet(previous)
  if (!stored) return []
  if (value.decision === "value") return [`The stored ${label} is replaced; the previous value can't be restored.`]
  if (value.decision === "unset" || value.unset === true) return [`The stored ${label} is deleted; it must be re-entered to restore it.`]
  return []
}

/** Parses the item spec at apply time: refs carry `id`, secrets carry decisions, so only the shape of plain fields is checked. */
export function specObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new ConfigApplyError("invalid_spec", "spec must be an object.")
  return value
}

// ---------------------------------------------------------------------------
// Reads shared by the serializers

/** Email (lowercased) of each member: their account email, or their invitation's for invited members. */
export async function loadMemberEmails(db: ConfigDb, organizationId: string, memberIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(memberIds)].map((id) => normalizeDenTypeId("member", id))
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({ id: MemberTable.id, userEmail: AuthUserTable.email, inviteEmail: InvitationTable.email })
    .from(MemberTable)
    .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
    .leftJoin(InvitationTable, eq(MemberTable.inviteId, InvitationTable.id))
    .where(and(eq(MemberTable.organizationId, normalizeDenTypeId("organization", organizationId)), inArray(MemberTable.id, ids)))
  const out = new Map<string, string>()
  for (const row of rows) {
    const email = row.userEmail ?? row.inviteEmail
    if (email) out.set(row.id, email.trim().toLowerCase())
  }
  return out
}

/**
 * Of these members, the ones who have not accepted their invitation yet: an
 * invitation's placeholder member row has no account. Some services refuse
 * them (a spend limit can only be assigned to someone who has joined).
 */
export async function loadPendingMemberIds(db: ConfigDb, organizationId: string, memberIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(memberIds)].filter((id) => isDenTypeId("member", id)).map((id) => normalizeDenTypeId("member", id))
  if (ids.length === 0) return new Set()
  const rows = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, normalizeDenTypeId("organization", organizationId)), inArray(MemberTable.id, ids), isNull(MemberTable.userId)))
  return new Set(rows.map((row) => row.id))
}

export const OWN_MANAGER_ACCESS_KEPT = "Your own manager access was kept."

/**
 * Plan time, for areas whose apply never takes away the applying member's own
 * manager access (skills, plugins, sources, collections: the person who
 * imports something keeps managing it, as its creator does in the dashboard).
 * A file exported by someone else doesn't list them, so every later import
 * would plan to remove them and then not do it. An update that is only that
 * difference is planned as a skip; next to other changes it is said before
 * approval.
 */
export async function ownManagerAccessPreflight(ctx: ConfigAreaContext, op: ConfigApplyOp): Promise<ConfigPreflightResult | null> {
  if (op.kind !== "update") return null
  const change = op.changes.find((entry) => entry.path === "access.members.manager")
  // The plan lists set members by their name hint, else their `$ref` (people have no name hint): engine/diff.ts.
  const removed = (change?.removed ?? []).flatMap((entry) => {
    if (typeof entry === "string") return [entry]
    return isJsonObject(entry) && typeof entry.$ref === "string" ? [entry.$ref] : []
  })
  if (removed.length === 0) return null
  const memberId = normalizeDenTypeId("member", ctx.actor.memberId)
  const email = (await loadMemberEmails(ctx.db, ctx.organizationId, [memberId])).get(memberId)
  // A caller who may not read the member directory sees people by member id (engine/people.ts).
  const own = new Set([`people/${memberId}`, ...(email ? [personRef(email).$ref] : [])])
  if (!removed.some((ref) => own.has(ref))) return null
  const only = op.secretPaths.length === 0 && op.changes.length === 1 && removed.length === 1 && (change?.added ?? []).length === 0
  return only
    ? { skip: "Nothing to change: only your own manager access differs, and an import keeps it." }
    : { warnings: ["Your own manager access will be kept."] }
}

export async function loadTeamNames(db: ConfigDb, organizationId: string, teamIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(teamIds)].map((id) => normalizeDenTypeId("team", id))
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({ id: TeamTable.id, name: TeamTable.name })
    .from(TeamTable)
    .where(and(eq(TeamTable.organizationId, normalizeDenTypeId("organization", organizationId)), inArray(TeamTable.id, ids)))
  return new Map(rows.map((row) => [row.id, row.name]))
}

/** Team refs sorted by id, people refs sorted by email (stable exports). Members without an email are skipped. */
export function audienceRefs(input: {
  teamIds: readonly string[]
  memberIds: readonly string[]
  teamNames: Map<string, string>
  memberEmails: Map<string, string>
}): { teams: ConfigRef[]; members: ConfigRef[] } {
  const teams = [...new Set(input.teamIds)].sort().map((id) => teamRef(id, input.teamNames.get(id)))
  const emails = [...new Set(input.memberIds.flatMap((id) => {
    const email = input.memberEmails.get(id)
    return email ? [email] : []
  }))].sort()
  return { teams, members: emails.map(personRef) }
}

/** Added and removed ids between the ids stored now and the ids wanted. */
export function idDiff(current: Iterable<string>, wanted: Iterable<string>): { added: string[]; removed: string[] } {
  const now = new Set(current)
  const next = new Set(wanted)
  return { added: [...next].filter((id) => !now.has(id)), removed: [...now].filter((id) => !next.has(id)) }
}

/** `add` / `remove` steps for team and people grants, named by team name and email. */
export async function audienceSteps(db: ConfigDb, organizationId: string, target: string, diff: {
  teams?: { added: string[]; removed: string[] }
  members?: { added: string[]; removed: string[] }
}): Promise<ConfigApplyStep[]> {
  const teams = diff.teams ?? { added: [], removed: [] }
  const members = diff.members ?? { added: [], removed: [] }
  const [teamNames, memberEmails] = await Promise.all([
    loadTeamNames(db, organizationId, [...teams.added, ...teams.removed]),
    loadMemberEmails(db, organizationId, [...members.added, ...members.removed]),
  ])
  return [
    ...setSteps(`${target}.teams`, teams.added.map((id) => teamNames.get(id) ?? id), teams.removed.map((id) => teamNames.get(id) ?? id)),
    ...setSteps(`${target}.members`, members.added.map((id) => memberEmails.get(id) ?? id), members.removed.map((id) => memberEmails.get(id) ?? id)),
  ]
}
