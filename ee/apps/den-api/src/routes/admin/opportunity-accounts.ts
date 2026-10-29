import { and, asc, desc, eq, gte, isNotNull, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { AccountFollowUpActionTable, AccountFollowUpTable, AuthUserTable, MemberTable, OrganizationTable, TelemetryEventTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId } from "@openwork-ee/utils/typeid"
import { accountFollowUpActionInputSchema, adminOpportunityAccountSchema, type ACCOUNT_FOLLOW_UP_STAGES } from "@openwork/types/den/admin-organization"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { parseOrganizationPlan } from "../../entitlements.js"
import { adminRoute, jsonValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import { readOrganizationFacts } from "./opportunity-overview.js"
import { adoptionOf, buildOpportunity, startOfUtcDay } from "./opportunity-queue.js"

const DAY = 86_400_000
type OrganizationId = typeof OrganizationTable.$inferSelect.id
type Input = z.infer<typeof accountFollowUpActionInputSchema>
type UserId = typeof AuthUserTable.$inferSelect.id
type Stage = (typeof ACCOUNT_FOLLOW_UP_STAGES)[number]

export async function readAdminOpportunityAccount(id: OrganizationId, now = new Date()) {
  const facts = (await readOrganizationFacts([id], now)).get(id)
  if (!facts) return null
  const [[organization], people, history] = await Promise.all([
    db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, id)).limit(1),
    // Existing platform-admin member data. Owners first, then the most recently observed people.
    db.select({
      memberId: MemberTable.id, userId: MemberTable.userId, name: AuthUserTable.name, email: AuthUserTable.email, role: MemberTable.role,
      joinedAt: MemberTable.joinedAt, signedUpAt: AuthUserTable.createdAt,
      lastObservedMs: sql<number | null>`(select unix_timestamp(max(${TelemetryEventTable.event_timestamp})) * 1000 from ${TelemetryEventTable}
        where ${TelemetryEventTable.member_id} = ${MemberTable.id} and ${TelemetryEventTable.org_id} = ${MemberTable.organizationId}
        and ${gte(TelemetryEventTable.event_timestamp, new Date(now.getTime() - 30 * DAY))} and ${TelemetryEventTable.event_timestamp} < ${now}
        and ${TelemetryEventTable.event_timestamp} >= ${MemberTable.joinedAt})`.as("last_observed_ms"),
    }).from(MemberTable).leftJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .where(and(eq(MemberTable.organizationId, id), isNull(MemberTable.removedAt), eq(MemberTable.isSetupAgent, false)))
      .orderBy(sql`case when ${MemberTable.role} like '%owner%' then 0 when ${MemberTable.role} like '%admin%' then 1 else 2 end`, desc(sql`last_observed_ms`), asc(MemberTable.joinedAt), asc(MemberTable.id)).limit(25),
    db.select({
      id: AccountFollowUpActionTable.id, kind: AccountFollowUpActionTable.kind, occurredAt: AccountFollowUpActionTable.occurredAt,
      note: AccountFollowUpActionTable.note, followUpDueAt: AccountFollowUpActionTable.followUpDueAt,
      actorName: sql<string | null>`(select ${AuthUserTable.name} from ${AuthUserTable} where ${AuthUserTable.id} = ${AccountFollowUpActionTable.actorUserId})`,
      contactName: sql<string | null>`(select ${AuthUserTable.name} from ${AuthUserTable} where ${AuthUserTable.id} = ${AccountFollowUpActionTable.contactUserId})`,
    }).from(AccountFollowUpActionTable).where(eq(AccountFollowUpActionTable.organizationId, id))
      .orderBy(desc(AccountFollowUpActionTable.occurredAt), desc(AccountFollowUpActionTable.id)).limit(25),
  ])
  return {
    organization: {
      id, name: facts.name, createdAt: facts.createdAt.toISOString(), planTier: parseOrganizationPlan(organization?.metadata ?? null).tier,
      seatLimit: facts.seatLimit, memberCount: facts.members,
    },
    people: people.map(({ lastObservedMs, ...person }) => ({
      ...person, joinedAt: person.joinedAt?.toISOString() ?? null, signedUpAt: person.signedUpAt?.toISOString() ?? null,
      lastObservedAt: lastObservedMs === null ? null : new Date(Number(lastObservedMs)).toISOString(),
    })),
    opportunity: buildOpportunity(facts, now), adoption: adoptionOf(facts), followUp: facts.followUp,
    history: history.map(entry => ({ ...entry, occurredAt: entry.occurredAt.toISOString(), followUpDueAt: entry.followUpDueAt?.toISOString() ?? null })),
    generatedAt: now.toISOString(), timeZone: "UTC" as const,
  }
}

const STAGE_AFTER: Record<Input["kind"], (previous: Stage) => Stage> = {
  reviewed: previous => previous === "needs_review" ? "ready" : previous,
  contacted: previous => previous === "engaged" ? "engaged" : "contacted",
  replied: () => "engaged", meeting: () => "engaged", note: previous => previous,
  closed: () => "closed", dismissed: () => "dismissed", reopened: () => "needs_review",
}

/** Records what happened and the next step together. Never sends a message or changes the organization. */
export async function recordAccountFollowUpAction(id: OrganizationId, actor: UserId, input: Input, now = new Date()) {
  const today = startOfUtcDay(now)
  const nextFollowUpAt = input.kind === "closed" || input.kind === "dismissed" || !input.followUpOn ? null : new Date(`${input.followUpOn}T00:00:00.000Z`)
  if (nextFollowUpAt && (nextFollowUpAt < today || nextFollowUpAt.getUTCFullYear() > 2037)) return { error: "date" as const }
  const contactUserId = input.contactUserId ?? null
  if (contactUserId !== null && !isDenTypeId("user", contactUserId)) return { error: "contact" as const }
  return db.transaction(async tx => {
    const [organization] = await tx.select({ id: OrganizationTable.id }).from(OrganizationTable).where(eq(OrganizationTable.id, id)).limit(1).for("update")
    if (!organization) return { error: "missing" as const }
    const [repeat] = await tx.select({ id: AccountFollowUpActionTable.id }).from(AccountFollowUpActionTable)
      .where(and(eq(AccountFollowUpActionTable.organizationId, id), eq(AccountFollowUpActionTable.requestId, input.requestId))).limit(1)
    if (repeat) return { actionId: repeat.id }
    if (contactUserId) {
      const [contact] = await tx.select({ id: MemberTable.id }).from(MemberTable).where(and(eq(MemberTable.organizationId, id), eq(MemberTable.userId, contactUserId),
        isNotNull(MemberTable.joinedAt), isNull(MemberTable.removedAt), eq(MemberTable.isSetupAgent, false))).limit(1)
      if (!contact) return { error: "contact" as const }
    }
    const [previous] = await tx.select().from(AccountFollowUpTable).where(eq(AccountFollowUpTable.organizationId, id)).limit(1)
    const outreach = input.kind === "contacted" || input.kind === "meeting"
    // Any step other than a note completes the follow-up that was scheduled.
    const completed = input.kind !== "note" && input.kind !== "reopened" && previous?.nextFollowUpAt ? previous.nextFollowUpAt : null
    const actionId = createDenTypeId("accountFollowUpAction")
    await tx.insert(AccountFollowUpActionTable).values({
      id: actionId, organizationId: id, requestId: input.requestId, kind: input.kind, actorUserId: actor,
      contactUserId, note: input.note || null, followUpDueAt: completed, occurredAt: now,
    })
    const state = {
      stage: STAGE_AFTER[input.kind](previous?.stage ?? "needs_review"),
      ownerUserId: input.assignToMe ? actor : previous?.ownerUserId ?? null,
      nextAction: input.kind === "closed" || input.kind === "dismissed" ? null : input.nextAction || null,
      nextFollowUpAt, lastContactedAt: outreach ? now : previous?.lastContactedAt ?? null,
      confirmedOpportunity: input.confirmedOpportunity === undefined ? previous?.confirmedOpportunity ?? null : input.confirmedOpportunity,
      updatedByUserId: actor, updatedAt: now,
    }
    await tx.insert(AccountFollowUpTable).values({ organizationId: id, ...state }).onDuplicateKeyUpdate({ set: state })
    return { actionId }
  })
}

export function registerAdminOpportunityAccountRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  const errors = {
    400: jsonResponse("Invalid organization, contact or follow-up date.", invalidRequestSchema),
    401: jsonResponse("Authentication required.", unauthorizedSchema), 403: jsonResponse("Platform admin access required.", forbiddenSchema),
    404: jsonResponse("Organization not found.", notFoundSchema),
  }
  app.get("/v1/admin/opportunities/accounts/:organizationId", describeRoute({
    tags: ["Admin"], summary: "Get an account's sales context",
    description: "Platform-admin-only. Returns the organization's current people (owners first, at most 25) with their existing admin-visible name, email and role, observed adoption, the transparent recommendation and its dated signals, and internal follow-up history. Internal context only: not visible to the organization.",
    responses: { 200: jsonResponse("Account context returned.", adminOpportunityAccountSchema), ...errors },
  }), adminRoute(), async c => {
    c.header("Cache-Control", "no-store")
    const id = c.req.param("organizationId")
    if (!isDenTypeId("organization", id)) return c.json({ error: "invalid_request", message: "Invalid organization id." }, 400)
    const account = await readAdminOpportunityAccount(id)
    return account ? c.json(account) : c.json({ error: "not_found", message: "Organization not found." }, 404)
  })
  app.post("/v1/admin/opportunities/accounts/:organizationId/actions", describeRoute({
    tags: ["Admin"], summary: "Record a sales follow-up step",
    description: "Platform-admin-only. Appends what happened (reviewed, contacted, reply, meeting, note, closed, dismissed or reopened) and sets the next action, owner and UTC follow-up date in one idempotent request. Never sends a message, changes the organization or writes to its audit log.",
    responses: { 200: jsonResponse("Step recorded, or the original retry returned.", z.object({ ok: z.literal(true), actionId: z.string() })), ...errors },
  }), adminRoute(), jsonValidator(accountFollowUpActionInputSchema), async c => {
    const id = c.req.param("organizationId")
    if (!isDenTypeId("organization", id)) return c.json({ error: "invalid_request", message: "Invalid organization id." }, 400)
    const result = await recordAccountFollowUpAction(id, c.get("user").id, c.req.valid("json"))
    if ("error" in result) {
      if (result.error === "missing") return c.json({ error: "not_found", message: "Organization not found." }, 404)
      return c.json({ error: "invalid_request", message: result.error === "date" ? "Choose today or a later follow-up date before 2038." : "Choose a current member of this organization as the contact." }, 400)
    }
    return c.json({ ok: true, actionId: result.actionId })
  })
}
