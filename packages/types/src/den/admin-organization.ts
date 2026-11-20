import { z } from "zod"
import { organizationPlanStateSchema } from "@openwork/types/den/billing-plans"

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const adminSubscriptionSummarySchema = z.object({
  status: z.string(), currentPeriodEnd: z.string().datetime().nullable(), cancelAtPeriodEnd: z.boolean(),
})
export const adminOrganizationDetailSchema = z.object({
  organization: z.object({
    id: z.string(), name: z.string(), slug: z.string().nullable(), createdAt: z.string().datetime(),
    planTier: z.string(), seatLimit: count, memberCount: count,
    /** The resolved plan: tier, who pays, users and the limit every join path enforces. Older Den APIs omit it. */
    plan: organizationPlanStateSchema.optional(),
    /** Users split into joined members and unexpired pending invitations. Older Den APIs omit it. */
    people: z.object({ joined: count, invited: count }).optional(),
    /** The organization's Team (seat) Stripe subscription, as last recorded. Older Den APIs omit it. */
    subscriptions: z.object({ team: adminSubscriptionSummarySchema.nullable() }).optional(),
    /** Complimentary OpenWork Web access and any paid OpenWork Web subscription. Older Den APIs omit it. */
    openworkWeb: z.object({
      complimentaryAccess: z.boolean(), hasAccess: z.boolean(), hasOngoingSubscription: z.boolean(), subscriptionStatus: z.string().nullable(),
    }).optional(),
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

// Billing comes from recorded subscriptions and the stored plan tier. "Paying" means a
// current active subscription; trials are not paying.
export const opportunityBillingSchema = z.object({
  plan: z.enum(["free", "team", "enterprise"]), paying: z.boolean(), modelsAddOn: z.boolean(),
})
// Contacted means a platform admin recorded outreach, a reply or a meeting.
export const opportunityOutreachSchema = z.object({
  status: z.enum(["not_contacted", "contacted"]), lastContactedAt: z.string().datetime().nullable(),
})

export const adminOpportunitiesSchema = z.object({
  from: z.string().datetime(), to: z.string().datetime(), generatedAt: z.string().datetime(),
  nextCursor: z.string().nullable().describe("Pass as cursor with the same filters and sort to continue; null on the last page."),
  organizations: z.array(z.object({
    id: z.string(), name: z.string(), slug: z.string(),
    members: count, activeMembers: count, lastActiveAt: z.string().datetime(),
    companyEmailMembers: count, companyDomain: z.string().nullable(), companyDomainCount: count,
    skills: count, mcpConnections: count,
    billing: opportunityBillingSchema, outreach: opportunityOutreachSchema,
  })).max(100),
  page: z.object({ limit: count, total: count, returned: count, hasMore: z.boolean() }),
}).meta({ ref: "AdminOpportunities" })
export type AdminOpportunities = z.infer<typeof adminOpportunitiesSchema>

export const adminSignupCompaniesSchema = z.object({
  from: z.string().datetime(), to: z.string().datetime(), generatedAt: z.string().datetime(),
  nextCursor: z.string().nullable().describe("Pass as cursor with the same filters and sort to continue; null on the last page."),
  companies: z.array(z.object({
    domain: z.string(), signups: count, organizations: count, activeUsers: count,
    firstSignupAt: z.string().datetime(), lastSignInAt: z.string().datetime().nullable(),
    billing: opportunityBillingSchema, outreach: opportunityOutreachSchema,
    workspaces: z.array(z.object({ id: z.string(), name: z.string(), members: count })).max(3),
  })).max(100),
  page: z.object({ limit: count, total: count, returned: count, hasMore: z.boolean() }),
}).meta({ ref: "AdminSignupCompanies" })
export type AdminSignupCompanies = z.infer<typeof adminSignupCompaniesSchema>

// Platform-internal sales follow-up. Never written to an organization's audit log or shown to its members.
export const ACCOUNT_FOLLOW_UP_STAGES = ["needs_review", "ready", "contacted", "engaged", "closed", "dismissed"] as const
export const ACCOUNT_FOLLOW_UP_ACTIONS = ["reviewed", "contacted", "replied", "meeting", "note", "closed", "dismissed", "reopened"] as const
export const ACCOUNT_CONFIRMED_OPPORTUNITIES = ["expansion", "commercial"] as const

const isoDate = z.string().datetime()
export const accountFollowUpSchema = z.object({
  stage: z.enum(ACCOUNT_FOLLOW_UP_STAGES), ownerUserId: z.string().nullable(), ownerName: z.string().nullable(),
  nextAction: z.string().nullable(), nextFollowUpAt: isoDate.nullable(), lastContactedAt: isoDate.nullable(),
  lastActionKind: z.enum(ACCOUNT_FOLLOW_UP_ACTIONS).nullable(), lastActionAt: isoDate.nullable(),
  confirmedOpportunity: z.enum(ACCOUNT_CONFIRMED_OPPORTUNITIES).nullable(), updatedAt: isoDate,
})

// Reasons to write to an account, strongest first. An account is listed once, under its strongest reason.
export const OUTREACH_PLAYS = [
  "follow_up", "payment", "cancelling", "team_no_plan", "seats_full", "company", "shrinking", "free_limit", "quiet_paying",
  // Accounts that used to run tasks and stopped, by what happened just before.
  "lapsed_failed", "lapsed_limit", "lapsed",
] as const
export type OutreachPlay = (typeof OUTREACH_PLAYS)[number]
const outreachPersonSchema = z.object({
  userId: z.string(), name: z.string().nullable(), email: z.string(), role: z.string(),
  activeDays: count.describe("UTC days in the window on which this person ran a task."),
})
export const outreachItemSchema = z.object({
  organizationId: z.string(), organizationName: z.string(), play: z.enum(OUTREACH_PLAYS),
  reason: z.string(), also: z.array(z.string()).max(6).describe("Other reasons that apply to the same account."),
  company: z.string().nullable().describe("Verified company email domain the reason is about, when there is one."),
  contact: outreachPersonSchema.nullable(), others: z.array(outreachPersonSchema).max(5),
  people: z.object({ members: count, active: count }),
  billing: opportunityBillingSchema, endsAt: isoDate.nullable().describe("When the plan in the reason ends or ended."),
  lastActiveAt: isoDate.nullable().describe("The last task anyone here ran in the last 60 days."),
  followUp: accountFollowUpSchema.nullable(),
})
export type OutreachItem = z.infer<typeof outreachItemSchema>

export const adminOutreachSchema = z.object({
  generatedAt: isoDate, windowDays: count,
  items: z.array(outreachItemSchema).max(400),
  totals: z.record(z.enum(OUTREACH_PLAYS), count).describe("Accounts per reason before the per-reason cap."),
  waiting: z.array(z.object({
    organizationId: z.string(), organizationName: z.string(), contactedAt: isoDate,
    ownerName: z.string().nullable(), followUpAt: isoDate.nullable(),
    activeAgainAt: isoDate.nullable().describe("First day after the contact on which someone here ran a task."),
  })).max(50),
  results: z.object({
    days: count, contacted: count, replied: count,
    quietWhenContacted: count.describe("Contacted accounts where nobody had run a task in the two weeks before."),
    cameBack: count.describe("Of those quiet accounts, the ones where someone ran a task after the contact. Observed, not attributed."),
  }).describe("What happened to the accounts admins recorded contacting."),
  hidden: count.describe("Accounts with a reason that an admin dismissed or closed."),
}).meta({ ref: "AdminOutreach" })
export type AdminOutreach = z.infer<typeof adminOutreachSchema>

export const accountFollowUpActionInputSchema = z.object({
  requestId: z.string().uuid(),
  kind: z.enum(ACCOUNT_FOLLOW_UP_ACTIONS),
  contactUserId: z.string().max(64).nullable().default(null),
  note: z.string().trim().max(500).nullable().default(null),
  nextAction: z.string().trim().max(240).nullable().default(null),
  followUpOn: z.string().date().nullable().default(null).meta({ description: "UTC calendar date (YYYY-MM-DD) of the next follow-up. Null clears it." }),
  assignToMe: z.boolean().default(false),
  confirmedOpportunity: z.enum(ACCOUNT_CONFIRMED_OPPORTUNITIES).nullable().optional(),
}).strict().meta({ ref: "AccountFollowUpActionInput" })
