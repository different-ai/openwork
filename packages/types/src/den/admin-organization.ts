import { z } from "zod"

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const adminOrganizationDetailSchema = z.object({
  organization: z.object({
    id: z.string(), name: z.string(), slug: z.string().nullable(), createdAt: z.string().datetime(),
    planTier: z.string(), seatLimit: count, memberCount: count,
  }),
  members: z.array(z.object({
    id: z.string(), userId: z.string().nullable(), name: z.string().nullable(), email: z.string().nullable(),
    role: z.string(), joinedAt: z.string().datetime().nullable(),
  })),
  page: z.object({ limit: count, offset: count, search: z.string(), total: count, returned: count, hasMore: z.boolean(), durationMs: count }),
  generatedAt: z.string().datetime(),
}).meta({ ref: "AdminOrganizationDetail" })

export const adminOrganizationUsageTotalsSchema = z.object({
  requests: count, tokens: count, costMicroUsd: count,
  unreportedRequests: count.nullable(), unpricedRequests: count.nullable(),
})

export const adminOrganizationUsageSchema = adminOrganizationDetailSchema.extend({
  usage: z.object({
    from: z.string(), to: z.string(), totals: adminOrganizationUsageTotalsSchema,
    members: z.array(adminOrganizationUsageTotalsSchema.extend({ memberId: z.string() })),
  }),
}).meta({ ref: "AdminOrganizationUsage" })

export type AdminOrganizationDetail = z.infer<typeof adminOrganizationDetailSchema>
export type AdminOrganizationUsage = z.infer<typeof adminOrganizationUsageSchema>
export type AdminOrganizationUsageTotals = z.infer<typeof adminOrganizationUsageTotalsSchema>

export const adminDashboardSchema = z.object({
  from: z.string(), to: z.string(), generatedAt: z.string().datetime(),
  activeOrganizations: count,
  totals: adminOrganizationUsageTotalsSchema,
  daily: z.array(adminOrganizationUsageTotalsSchema.extend({ date: z.string() })).max(30),
  organizations: z.array(adminOrganizationUsageTotalsSchema.extend({ id: z.string(), name: z.string() })).max(8),
}).meta({ ref: "AdminDashboard" })
export type AdminDashboard = z.infer<typeof adminDashboardSchema>

/** Read on request only: it scans 30 days of platform activity. */
export const adminActiveUsersSchema = z.object({
  today: count, days7: count, days30: count, generatedAt: z.string().datetime(),
}).meta({ ref: "AdminActiveUsers" })
export type AdminActiveUsers = z.infer<typeof adminActiveUsersSchema>

const insightTotals = adminOrganizationUsageTotalsSchema.extend({
  activeMembers: count, successfulRequests: count, lastActiveDay: z.string().nullable(),
})
export const adminOrganizationInsightsSchema = adminOrganizationDetailSchema.extend({
  insights: z.object({
    from: z.string(), to: z.string(), previousFrom: z.string(), previousTo: z.string(),
    current: insightTotals, previous: insightTotals,
    daily: z.array(insightTotals.extend({ date: z.string() })).length(30),
    people: z.array(insightTotals.extend({ memberId: z.string(), userId: z.string().nullable(), name: z.string().nullable(), email: z.string().nullable(), currentMember: z.boolean() })).max(8),
    models: z.array(insightTotals.omit({ activeMembers: true }).extend({ id: z.string(), name: z.string(), provider: z.string() })).max(8),
  }),
}).meta({ ref: "AdminOrganizationInsights" })
export type AdminOrganizationInsights = z.infer<typeof adminOrganizationInsightsSchema>
