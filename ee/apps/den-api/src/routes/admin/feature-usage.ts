import { and, eq, isNull, isNotNull } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { readFeatureRollouts, readOrganizationFeatureOverrides, readOrganizationFeatureUsage, readOrganizationMemberFeatureOverrides } from "@openwork-ee/den-db/organization-features"
import { isDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { availableFeatureKeys, featureAvailableOn, featureKeySchema, resolveFeature, type FeatureKey } from "@openwork/features"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { env } from "../../env.js"
import type { FeatureHealth, FeatureOutcomeSummary, FeatureOutcomeTotals } from "../../feature-outcomes/outcomes.js"
import { readFeatureReport, readFeatureReports, type FeatureReport } from "../../feature-outcomes/report.js"
import { adminRoute, queryValidator } from "../../middleware/index.js"
import { featureHealth, featureOutcomeRange, summarizeFeatureOutcomes } from "../../feature-outcomes/outcomes.js"
import { readSlackSendAsBotOutcomes } from "../../feature-outcomes/slack-send-as-bot.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

const DAY_MS = 24 * 60 * 60 * 1000

const featureUsageMemberSchema = z.object({
  memberId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  /** Whether the feature is on for this member now; a member can have used it before it was turned off. */
  enabled: z.boolean(),
  firstUsedAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime(),
  daysUsed: z.number().int(),
})

const featureUsageSchema = z.object({
  key: featureKeySchema,
  /** Active members the feature is on for now. */
  enabledMembers: z.number().int(),
  /** Members who used it in the last 7 and 30 days. */
  usedLast7Days: z.number().int(),
  usedLast30Days: z.number().int(),
  /** Everyone who ever used it, most recent first. */
  members: z.array(featureUsageMemberSchema),
})

const responseSchema = z.object({
  activeMembers: z.number().int(),
  features: z.array(featureUsageSchema),
  generatedAt: z.iso.datetime(),
}).meta({ ref: "AdminOrganizationFeatureUsage" })

const rangeSchema = z.enum(["7d", "30d"])
const rangeQuerySchema = z.object({ range: rangeSchema.default("7d") })

const outcomeUnitSchema = z.enum(["run", "meeting", "check", "message"])

const featureHealthSchema = z.object({
  /** not_used, in_use (no outcomes to judge), healthy, failing (count failed), limited (count members at a limit), mostly_skipped. */
  status: z.enum(["not_used", "in_use", "healthy", "failing", "limited", "mostly_skipped"]),
  count: z.number().int().nullable(),
})

const outcomeTotalsSchema = z.object({
  runs: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  /** Of the runs, messages that reached the member; null when the feature's store does not say. */
  delivered: z.number().int().nullable(),
  /** Members held back by a limit; null when the feature has none. */
  limited: z.number().int().nullable(),
  lastRunAt: z.iso.datetime().nullable(),
})

const featureOutcomesSchema = outcomeTotalsSchema.extend({
  /** What one run is: run, meeting (one per meeting), check or message. */
  unit: outcomeUnitSchema,
  /** Every UTC day of the range, oldest first. */
  days: z.array(z.object({ day: z.string(), runs: z.number().int(), failed: z.number().int() })),
  /** Set when the store keeps less than the range: from when, and whether that limits all counts or only failures. */
  coverage: z.object({ from: z.iso.datetime(), counts: z.enum(["all", "failed"]) }).nullable(),
})

const featureReportSchema = z.object({
  key: featureKeySchema,
  /** Organizations the feature is on for now. */
  organizationsOn: z.number().int(),
  /** Active members who used it in the range (feature_usage). */
  membersUsing: z.number().int(),
  lastUsedAt: z.iso.datetime().nullable(),
  health: featureHealthSchema,
  /** Null when the feature has no outcome reader: adoption only. */
  outcomes: featureOutcomesSchema.nullable(),
})

const rangeFields = {
  range: rangeSchema,
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  /** Every organization on the deployment. */
  organizations: z.number().int(),
}

const featureOutcomesResponseSchema = z.object({
  ...rangeFields,
  features: z.array(featureReportSchema),
  generatedAt: z.iso.datetime(),
}).meta({ ref: "AdminFeatureOutcomes" })

const featureOutcomeDetailResponseSchema = z.object({
  ...rangeFields,
  feature: featureReportSchema.extend({
    /** Failed and skipped runs by reason code, most first. */
    reasons: z.array(z.object({ reason: z.string(), outcome: z.enum(["failed", "skipped"]), count: z.number().int() })),
    byOrganization: z.array(z.object({
      organizationId: z.string(),
      name: z.string(),
      /** Whether the feature is on for the organization now. */
      enabled: z.boolean(),
      membersUsing: z.number().int(),
      lastUsedAt: z.iso.datetime().nullable(),
      outcomes: outcomeTotalsSchema.nullable(),
    })),
  }),
  generatedAt: z.iso.datetime(),
}).meta({ ref: "AdminFeatureOutcomeDetail" })

const iso = (value: Date | null) => value ? value.toISOString() : null

function healthJson(health: FeatureHealth) {
  return { status: health.status, count: "count" in health ? health.count : null }
}

function totalsJson(totals: FeatureOutcomeTotals) {
  return {
    runs: totals.runs,
    succeeded: totals.succeeded,
    failed: totals.failed,
    skipped: totals.skipped,
    delivered: totals.delivered,
    limited: totals.limited,
    lastRunAt: iso(totals.lastRunAt),
  }
}

function outcomesJson(outcomes: FeatureOutcomeSummary | null) {
  if (!outcomes) return null
  return {
    ...totalsJson(outcomes),
    unit: outcomes.unit,
    days: outcomes.days,
    coverage: outcomes.coverage ? { from: outcomes.coverage.from.toISOString(), counts: outcomes.coverage.counts } : null,
  }
}

function featureJson(feature: FeatureReport) {
  return {
    key: feature.key,
    organizationsOn: feature.organizationsOn,
    membersUsing: feature.membersUsing,
    lastUsedAt: iso(feature.lastUsedAt),
    health: healthJson(feature.health),
    outcomes: outcomesJson(feature.outcomes),
  }
}

export function registerAdminFeatureUsageRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  // Operational diagnostics outlive the rollout. Slack messages still record
  // success, refusal reasons and rate limits in their existing store.
  app.get(
    "/v1/admin/slack-send-as-bot/outcomes",
    describeRoute({
      tags: ["Admin"],
      summary: "Slack bot message outcomes",
      description: "Slack bot message totals, failures by reason, limits, coverage and daily outcomes for the last 7 or 30 UTC days. Independent of feature rollouts. Counts only; never message text. Platform administrators only.",
      responses: {
        200: jsonResponse("Slack bot message outcomes.", z.object({
          range: rangeSchema,
          from: z.iso.datetime(),
          to: z.iso.datetime(),
          health: featureHealthSchema,
          outcomes: featureOutcomesSchema,
          reasons: z.array(z.object({ reason: z.string(), outcome: z.enum(["failed", "skipped"]), count: z.number().int() })),
          byOrganization: z.array(z.object({ organizationId: z.string(), outcomes: outcomeTotalsSchema })),
        })),
        400: jsonResponse("Invalid range.", invalidRequestSchema),
        401: jsonResponse("Sign in required.", unauthorizedSchema),
        403: jsonResponse("Platform administrator required.", forbiddenSchema),
      },
    }),
    adminRoute(),
    queryValidator(rangeQuerySchema),
    async (c) => {
      const { range } = c.req.valid("query")
      const window = featureOutcomeRange(range === "30d" ? 30 : 7, new Date())
      const outcomes = summarizeFeatureOutcomes(await readSlackSendAsBotOutcomes(window), window)
      return c.json({
        range,
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        health: healthJson(featureHealth({ membersUsing: 0, outcomes })),
        outcomes: outcomesJson(outcomes),
        reasons: outcomes.reasons,
        byOrganization: [...outcomes.byOrganization].map(([organizationId, totals]) => ({ organizationId, outcomes: totalsJson(totals) })),
      })
    },
  )

  app.get(
    "/v1/admin/feature-usage",
    describeRoute({
      tags: ["Admin"],
      summary: "Whether each feature is used and working, across organizations",
      description: "For every feature on this deployment and the last 7 or 30 UTC days (range, default 7d): how many organizations have it on, how many active members used it and when last, and, for features that work in the background (registry `outcomes: true`), what it did: runs, succeeded, failed, skipped, messages delivered, members held by a limit and a per-day series, read from the store that owns them (automation_run, Your agent's checks, slack_send_as_bot limits). Each feature has one health state. Counts only: no meeting titles, names or message text. Platform administrators only.",
      responses: {
        200: jsonResponse("Feature outcomes returned.", featureOutcomesResponseSchema),
        400: jsonResponse("Invalid range.", invalidRequestSchema),
        401: jsonResponse("Sign in required.", unauthorizedSchema),
        403: jsonResponse("Platform administrator required.", forbiddenSchema),
      },
    }),
    adminRoute(),
    queryValidator(rangeQuerySchema),
    async (c) => {
      const { range } = c.req.valid("query")
      const report = await readFeatureReports(range)
      return c.json({
        range,
        from: report.range.from.toISOString(),
        to: report.range.to.toISOString(),
        organizations: report.organizations,
        features: report.features.map(featureJson),
        generatedAt: new Date().toISOString(),
      })
    },
  )

  app.get(
    "/v1/admin/feature-usage/:key",
    describeRoute({
      tags: ["Admin"],
      summary: "One feature's use and outcomes by organization",
      description: "The same counts as GET /v1/admin/feature-usage for one feature, plus failed and skipped runs by reason code and one row per organization that used it, has outcomes in the range or overrides it: its name, whether the feature is on for it now, members using it, last use and its outcome totals. At most 200 organizations, busiest first. Counts only. Platform administrators only.",
      responses: {
        200: jsonResponse("Feature outcomes returned.", featureOutcomeDetailResponseSchema),
        400: jsonResponse("Unknown feature or invalid range.", invalidRequestSchema),
        401: jsonResponse("Sign in required.", unauthorizedSchema),
        403: jsonResponse("Platform administrator required.", forbiddenSchema),
        404: jsonResponse("The feature is not part of this deployment.", notFoundSchema),
      },
    }),
    adminRoute(),
    queryValidator(rangeQuerySchema),
    async (c) => {
      const key = featureKeySchema.safeParse(c.req.param("key"))
      if (!key.success) return c.json({ error: "invalid_request", message: "Unknown feature." }, 400)
      if (!featureAvailableOn(key.data, env.features.deployment)) return c.json({ error: "not_found", message: "The feature is not part of this deployment." }, 404)
      const { range } = c.req.valid("query")
      const report = await readFeatureReport(key.data, range)
      const { feature } = report
      return c.json({
        range,
        from: report.range.from.toISOString(),
        to: report.range.to.toISOString(),
        organizations: report.organizations,
        feature: {
          ...featureJson(feature),
          reasons: feature.outcomes?.reasons ?? [],
          byOrganization: feature.byOrganization.map((row) => ({
            organizationId: row.organizationId,
            name: row.name,
            enabled: row.enabled,
            membersUsing: row.membersUsing,
            lastUsedAt: iso(row.lastUsedAt),
            outcomes: row.outcomes ? totalsJson(row.outcomes) : null,
          })),
        },
        generatedAt: new Date().toISOString(),
      })
    },
  )

  app.get(
    "/v1/admin/organizations/:organizationId/feature-usage",
    describeRoute({
      tags: ["Admin"],
      summary: "Who has and uses each feature in an organization",
      description: "For every feature on this deployment: how many active members have it on now, how many used it in the last 7 and 30 days, and each member who used it with first and last use and days used. A use is a request through a feature-gated route, a client report (POST /v1/org/feature-usage), or background work done for the member (an interval or calendar Automation occurrence, a Your agent check, a slack_send_as_bot message). Platform administrators only.",
      responses: {
        200: jsonResponse("Feature usage returned.", responseSchema),
        400: jsonResponse("Invalid organization id.", invalidRequestSchema),
        401: jsonResponse("Sign in required.", unauthorizedSchema),
        403: jsonResponse("Platform administrator required.", forbiddenSchema),
        404: jsonResponse("The organization does not exist.", notFoundSchema),
      },
    }),
    adminRoute(),
    async (c) => {
      const organizationId = c.req.param("organizationId")
      if (!isDenTypeId("organization", organizationId)) return c.json({ error: "invalid_request", message: "Invalid organization id." }, 400)
      const [organization] = await db.select({ id: OrganizationTable.id }).from(OrganizationTable).where(eq(OrganizationTable.id, organizationId)).limit(1)
      if (!organization) return c.json({ error: "not_found", message: "Organization not found." }, 404)

      const [members, rollouts, overrides, memberOverrides, usage] = await Promise.all([
        db.select({ id: MemberTable.id, name: AuthUserTable.name, email: AuthUserTable.email })
          .from(MemberTable).leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
          .where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt), eq(MemberTable.isSetupAgent, false), isNotNull(MemberTable.userId))),
        readFeatureRollouts(db),
        readOrganizationFeatureOverrides(db, organizationId),
        readOrganizationMemberFeatureOverrides(db, organizationId),
        readOrganizationFeatureUsage(db, organizationId),
      ])

      const context = { ...env.features, rollouts, overrides }
      const enabledFor = (key: FeatureKey, memberId: DenTypeId<"member">) => resolveFeature(key, { ...context, memberOverrides: memberOverrides.get(memberId) ?? {} }).enabled
      const people = new Map(members.map((member) => [member.id, member]))
      const now = Date.now()

      const features = availableFeatureKeys(env.features.deployment).map((key) => {
        const used = usage
          .filter((row) => row.featureKey === key && people.has(row.memberId))
          .sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime())
        const usedWithin = (days: number) => used.filter((row) => now - row.lastUsedAt.getTime() <= days * DAY_MS).length
        return {
          key,
          enabledMembers: members.filter((member) => enabledFor(key, member.id)).length,
          usedLast7Days: usedWithin(7),
          usedLast30Days: usedWithin(30),
          members: used.map((row) => {
            const person = people.get(row.memberId)
            return {
              memberId: row.memberId,
              name: person?.name ?? null,
              email: person?.email ?? null,
              enabled: enabledFor(key, row.memberId),
              firstUsedAt: row.firstUsedAt.toISOString(),
              lastUsedAt: row.lastUsedAt.toISOString(),
              daysUsed: row.daysUsed,
            }
          }),
        }
      })

      return c.json({ activeMembers: members.length, features, generatedAt: new Date().toISOString() })
    },
  )
}
