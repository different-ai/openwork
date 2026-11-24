import { and, count, eq, gte, inArray, or, sql, type SQL } from "@openwork-ee/den-db/drizzle"
import { z } from "zod"
import { recordFreeAutoFounder } from "@openwork-ee/den-db"
import {
  AuthUserTable,
  FreeAutoOrgFounderTable,
  MemberTable,
  OrganizationTable,
  WorkspaceCreateIdentityTable,
  WorkspaceCreateLimitRuleTable,
} from "@openwork-ee/den-db/schema"
import {
  normalizeEmailDomain,
  normalizeEmailIdentity,
  type WorkspaceLimitRule,
  type WorkspaceLimitRuleInput,
  type WorkspaceLimitRuleScope,
  type WorkspaceLimitSettings,
} from "@openwork/types/den/admin-limits"
import type { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { writePlatformAuditEvent } from "./audit/request-capture.js"
import { db } from "./db.js"
import { env } from "./env.js"
import { deploymentFeatureEnabled } from "./features.js"

type UserId = ReturnType<typeof normalizeDenTypeId<"user">>
type Reader = Pick<typeof db, "select">
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type WorkspaceLimitReached = { error: "workspace_limit_reached"; message: string; limit: number; windowDays: number; contact: string }

export const workspaceLimitReachedSchema = z.object({
  error: z.literal("workspace_limit_reached"),
  message: z.string(),
  limit: z.number().int().positive(),
  windowDays: z.number().int().min(0).describe("Rolling window in days. 0 counts every workspace the person founded."),
  contact: z.string().describe("Where the person can ask to raise the limit, as a mailto or https link."),
}).meta({ ref: "WorkspaceLimitReachedError" })

export class WorkspaceLimitReachedError extends Error {
  constructor(readonly body: WorkspaceLimitReached) {
    super(body.message)
  }
}

export function workspaceLimitReachedBody(limit: number): WorkspaceLimitReached {
  const noun = limit === 1 ? "workspace" : "workspaces"
  return {
    error: "workspace_limit_reached",
    message: `You've reached the limit of ${limit} ${noun}. Contact us to raise it.`,
    limit,
    windowDays: env.workspaceCreateLimit.windowDays,
    contact: env.workspaceCreateLimit.contact,
  }
}

const lowered = sql`LOWER(TRIM(${AuthUserTable.email}))`
const emailDomain = sql`SUBSTRING_INDEX(${lowered}, '@', -1)`
const emailBase = sql`SUBSTRING_INDEX(SUBSTRING_INDEX(${lowered}, '@', 1), '+', 1)`
const emailIdentity = sql`CASE WHEN ${emailDomain} IN ('gmail.com', 'googlemail.com')
  THEN CONCAT(REPLACE(${emailBase}, '.', ''), '@gmail.com') ELSE CONCAT(${emailBase}, '@', ${emailDomain}) END`

type Person = { userId: UserId; identity: string | null }

async function readPerson(reader: Reader, userId: UserId): Promise<Person | null> {
  const [user] = await reader.select({ email: AuthUserTable.email }).from(AuthUserTable).where(eq(AuthUserTable.id, userId)).limit(1)
  return user ? { userId, identity: normalizeEmailIdentity(user.email) } : null
}

type ResolvedLimit = { limit: number | null; rule: WorkspaceLimitRuleScope | null }

async function resolveLimit(reader: Reader, person: Person): Promise<ResolvedLimit> {
  const fallback = env.workspaceCreateLimit.limit > 0 ? env.workspaceCreateLimit.limit : null
  if (!person.identity) return { limit: fallback, rule: null }
  const domain = person.identity.split("@")[1] ?? ""
  const rules = await reader
    .select({ scope: WorkspaceCreateLimitRuleTable.scope, limit: WorkspaceCreateLimitRuleTable.workspace_limit })
    .from(WorkspaceCreateLimitRuleTable)
    .where(or(
      and(eq(WorkspaceCreateLimitRuleTable.scope, "email"), eq(WorkspaceCreateLimitRuleTable.value, person.identity)),
      and(eq(WorkspaceCreateLimitRuleTable.scope, "domain"), eq(WorkspaceCreateLimitRuleTable.value, domain)),
    ))
  const match = rules.find(rule => rule.scope === "email") ?? rules.find(rule => rule.scope === "domain")
  return match ? { limit: match.limit, rule: match.scope } : { limit: fallback, rule: null }
}

async function countFounded(reader: Reader, person: Person): Promise<number> {
  const conditions: SQL[] = []
  if (env.workspaceCreateLimit.windowDays > 0) {
    conditions.push(gte(OrganizationTable.createdAt, new Date(Date.now() - env.workspaceCreateLimit.windowDays * 86_400_000)))
  }
  if (person.identity) {
    const domain = person.identity.split("@")[1] ?? ""
    const domains = domain === "gmail.com" ? ["gmail.com", "googlemail.com"] : [domain]
    conditions.push(inArray(emailDomain, domains), sql`${emailIdentity} = ${person.identity}`)
  } else {
    conditions.push(eq(FreeAutoOrgFounderTable.founder_user_id, person.userId))
  }
  const [row] = await reader
    .select({ value: count() })
    .from(FreeAutoOrgFounderTable)
    .innerJoin(OrganizationTable, eq(OrganizationTable.id, FreeAutoOrgFounderTable.organization_id))
    .innerJoin(AuthUserTable, eq(AuthUserTable.id, FreeAutoOrgFounderTable.founder_user_id))
    .where(and(...conditions))
  return row?.value ?? 0
}

export async function assertWorkspaceCreateAllowed(tx: Tx, userId: UserId): Promise<void> {
  if (!await deploymentFeatureEnabled("workspaceCreateLimit")) return
  const [user] = await tx.select({ email: AuthUserTable.email }).from(AuthUserTable).where(eq(AuthUserTable.id, userId)).limit(1).for("update")
  if (!user) return
  const person: Person = { userId, identity: normalizeEmailIdentity(user.email) }
  if (person.identity) {
    await tx.insert(WorkspaceCreateIdentityTable).values({ identity: person.identity })
      .onDuplicateKeyUpdate({ set: { identity: sql`${WorkspaceCreateIdentityTable.identity}` } })
  }
  const { limit } = await resolveLimit(tx, person)
  if (limit === null) return
  if (await countFounded(tx, person) >= limit) throw new WorkspaceLimitReachedError(workspaceLimitReachedBody(limit))
}

export async function recordFounderWithinLimit(organizationId: ReturnType<typeof normalizeDenTypeId<"organization">>, userId: UserId): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await assertWorkspaceCreateAllowed(tx, userId)
      await recordFreeAutoFounder(tx, organizationId, userId)
    })
  } catch (error) {
    if (error instanceof WorkspaceLimitReachedError) {
      await db.transaction(async (tx) => {
        await tx.delete(MemberTable).where(eq(MemberTable.organizationId, organizationId))
        await tx.delete(OrganizationTable).where(eq(OrganizationTable.id, organizationId))
      })
    }
    throw error
  }
}

export const workspaceCreateLimitStatusSchema = z.object({
  userId: z.string(),
  identity: z.string().nullable().describe("Normalized email the count and rules use."),
  enforcementEnabled: z.boolean(),
  limit: z.number().int().positive().nullable().describe("Effective limit. Null means no limit."),
  rule: z.enum(["email", "domain"]).nullable().describe("Which rule set the limit, or null for the deployment default."),
  created: z.number().int().min(0).describe("Workspaces this person founded inside the window, across alias accounts."),
  windowDays: z.number().int().min(0),
}).meta({ ref: "WorkspaceCreateLimitStatus" })

export async function readWorkspaceCreateLimitStatus(userId: UserId): Promise<z.infer<typeof workspaceCreateLimitStatusSchema> | null> {
  const person = await readPerson(db, userId)
  if (!person) return null
  const resolved = await resolveLimit(db, person)
  return {
    userId,
    identity: person.identity,
    enforcementEnabled: await deploymentFeatureEnabled("workspaceCreateLimit"),
    limit: resolved.limit,
    rule: resolved.rule,
    created: await countFounded(db, person),
    windowDays: env.workspaceCreateLimit.windowDays,
  }
}

export function normalizeRuleValue(scope: WorkspaceLimitRuleScope, value: string): string | null {
  return scope === "email" ? normalizeEmailIdentity(value) : normalizeEmailDomain(value)
}

export async function readWorkspaceLimitSettings(): Promise<WorkspaceLimitSettings> {
  const rows = await db.select().from(WorkspaceCreateLimitRuleTable)
  const rules: WorkspaceLimitRule[] = rows
    .map(row => ({ id: `${row.scope}:${row.value}`, scope: row.scope, value: row.value, limit: row.workspace_limit, updatedAt: row.updated_at.toISOString() }))
    .sort((a, b) => a.scope.localeCompare(b.scope) || a.value.localeCompare(b.value))
  return {
    enforcementEnabled: await deploymentFeatureEnabled("workspaceCreateLimit"),
    defaultLimit: env.workspaceCreateLimit.limit,
    windowDays: env.workspaceCreateLimit.windowDays,
    rules,
  }
}

export async function setWorkspaceLimitRule(input: WorkspaceLimitRuleInput & { setByUserId: UserId }): Promise<string | null> {
  const value = normalizeRuleValue(input.scope, input.value)
  if (!value) return null
  await db.insert(WorkspaceCreateLimitRuleTable)
    .values({ scope: input.scope, value, workspace_limit: input.limit, set_by_user_id: input.setByUserId })
    .onDuplicateKeyUpdate({ set: { workspace_limit: input.limit, set_by_user_id: input.setByUserId } })
  return value
}

export async function removeWorkspaceLimitRule(scope: WorkspaceLimitRuleScope, value: string): Promise<boolean> {
  const normalized = normalizeRuleValue(scope, value)
  if (!normalized) return false
  const match = and(eq(WorkspaceCreateLimitRuleTable.scope, scope), eq(WorkspaceCreateLimitRuleTable.value, normalized))
  const [existing] = await db.select({ value: WorkspaceCreateLimitRuleTable.value }).from(WorkspaceCreateLimitRuleTable).where(match).limit(1)
  if (!existing) return false
  await db.delete(WorkspaceCreateLimitRuleTable).where(match)
  return true
}

export async function recordWorkspaceLimitReached(input: { requestId: unknown; method: string; route: string; userId: UserId }) {
  if (!env.auditCaptureEnabled) return
  await writePlatformAuditEvent(typeof input.requestId === "string" && input.requestId ? input.requestId : null, {
    method: input.method,
    route: input.route,
    action: "workspace.create_limit.reached",
    outcome: "denied",
    status: 403,
    reasonCode: "workspace_limit_reached",
    actor: { type: "user", id: input.userId },
    origin: "api",
    target: { type: "user", id: input.userId },
  })
}
