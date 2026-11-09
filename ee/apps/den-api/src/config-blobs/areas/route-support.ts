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
 * Audit: these handlers are recorded by generic request capture (the route
 * middleware), which does not run here. TODO(config-blobs): the engine records
 * the apply as a `tenant_job` audit operation; per-item request evidence for
 * these areas comes from that operation, not from route capture.
 */
import { randomUUID } from "node:crypto"
import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, InvitationTable, MemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  configRefSchema,
  configSecretSchema,
  type ConfigRef,
  type ResolvedConfigSecret,
} from "@openwork/types/den/config-blobs"
import { Context } from "hono"
import { z } from "zod"
import { getOrganizationContextForUser, type OrganizationContext } from "../../orgs.js"
import type { OrgRouteVariables } from "../../routes/org/shared.js"
import type { ConfigAreaContext, ConfigDb } from "../area.js"

export type JsonObject = { [key: string]: unknown }

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A failed apply step. `code` is the route's error code when it came from one. */
export class ConfigApplyError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message)
    this.name = "ConfigApplyError"
  }
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
 * signed in: approving a change request is the step-up (the engine requires a
 * recent sign-in, or a config token, to approve).
 * TODO(config-blobs): if approval stops requiring a fresh session, give this
 * session the approver's real sign-in time instead.
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
  const message = isJsonObject(body) && typeof body.message === "string" ? body.message : `${action} failed (${response.status}).`
  throw new ConfigApplyError(code, `${action}: ${message}`, response.status)
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
