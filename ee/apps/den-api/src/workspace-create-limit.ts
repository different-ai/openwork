import { and, count, eq, gte } from "@openwork-ee/den-db/drizzle"
import { z } from "zod"
import { recordFreeAutoFounder } from "@openwork-ee/den-db"
import { AuthUserTable, FreeAutoOrgFounderTable, MemberTable, OrganizationTable, WorkspaceCreateLimitOverrideTable } from "@openwork-ee/den-db/schema"
import type { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { writePlatformAuditEvent } from "./audit/request-capture.js"
import { db } from "./db.js"
import { env } from "./env.js"
import { deploymentFeatureEnabled } from "./features.js"

type UserId = ReturnType<typeof normalizeDenTypeId<"user">>
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

/** The effective limit for one person, or null when they can create any number. */
export async function readWorkspaceCreateLimit(reader: Pick<typeof db, "select">, userId: UserId): Promise<number | null> {
  const [override] = await reader
    .select({ limit: WorkspaceCreateLimitOverrideTable.workspace_limit })
    .from(WorkspaceCreateLimitOverrideTable)
    .where(eq(WorkspaceCreateLimitOverrideTable.user_id, userId))
    .limit(1)
  const limit = override ? override.limit : env.workspaceCreateLimit.limit
  return limit && limit > 0 ? limit : null
}

/** Workspaces this person founded inside the window. Founder records survive ownership transfers. */
export async function countFoundedWorkspaces(reader: Pick<typeof db, "select">, userId: UserId): Promise<number> {
  const conditions = [eq(FreeAutoOrgFounderTable.founder_user_id, userId)]
  if (env.workspaceCreateLimit.windowDays > 0) {
    conditions.push(gte(OrganizationTable.createdAt, new Date(Date.now() - env.workspaceCreateLimit.windowDays * 86_400_000)))
  }
  const [row] = await reader
    .select({ value: count() })
    .from(FreeAutoOrgFounderTable)
    .innerJoin(OrganizationTable, eq(OrganizationTable.id, FreeAutoOrgFounderTable.organization_id))
    .where(and(...conditions))
  return row?.value ?? 0
}

/**
 * Call inside the transaction that records the new founder. Locking the person's user row
 * serializes their concurrent creations, so the count cannot be read stale by a parallel request.
 */
export async function assertWorkspaceCreateAllowed(tx: Tx, userId: UserId): Promise<void> {
  if (!await deploymentFeatureEnabled("workspaceCreateLimit")) return
  await tx.select({ id: AuthUserTable.id }).from(AuthUserTable).where(eq(AuthUserTable.id, userId)).limit(1).for("update")
  const limit = await readWorkspaceCreateLimit(tx, userId)
  if (limit === null) return
  if (await countFoundedWorkspaces(tx, userId) >= limit) throw new WorkspaceLimitReachedError(workspaceLimitReachedBody(limit))
}

/**
 * Better Auth inserts the organization before its after-create hook runs. Record the founder under the
 * same per-person lock as the other paths and remove the new organization when it would exceed the limit.
 */
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
  enforcementEnabled: z.boolean(),
  limit: z.number().int().positive().nullable().describe("Effective limit. Null means no limit."),
  override: z.boolean().describe("True when a platform admin set this person's limit."),
  created: z.number().int().min(0).describe("Workspaces this person founded inside the window."),
  windowDays: z.number().int().min(0),
}).meta({ ref: "WorkspaceCreateLimitStatus" })

export async function readWorkspaceCreateLimitStatus(userId: UserId): Promise<z.infer<typeof workspaceCreateLimitStatusSchema> | null> {
  const [user] = await db.select({ id: AuthUserTable.id }).from(AuthUserTable).where(eq(AuthUserTable.id, userId)).limit(1)
  if (!user) return null
  const [override] = await db.select({ id: WorkspaceCreateLimitOverrideTable.user_id }).from(WorkspaceCreateLimitOverrideTable)
    .where(eq(WorkspaceCreateLimitOverrideTable.user_id, userId)).limit(1)
  return {
    userId,
    enforcementEnabled: await deploymentFeatureEnabled("workspaceCreateLimit"),
    limit: await readWorkspaceCreateLimit(db, userId),
    override: Boolean(override),
    created: await countFoundedWorkspaces(db, userId),
    windowDays: env.workspaceCreateLimit.windowDays,
  }
}

/** limit: a number raises or lowers it, null removes it, "default" restores the deployment limit. */
export async function setWorkspaceCreateLimitOverride(input: { userId: UserId; limit: number | null | "default"; setByUserId: UserId }) {
  if (input.limit === "default") {
    await db.delete(WorkspaceCreateLimitOverrideTable).where(eq(WorkspaceCreateLimitOverrideTable.user_id, input.userId))
    return
  }
  await db.insert(WorkspaceCreateLimitOverrideTable)
    .values({ user_id: input.userId, workspace_limit: input.limit, set_by_user_id: input.setByUserId })
    .onDuplicateKeyUpdate({ set: { workspace_limit: input.limit, set_by_user_id: input.setByUserId } })
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
