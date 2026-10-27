import { inArray, sql, type SQL } from "@openwork-ee/den-db/drizzle"
import { AccountFollowUpTable, AuthUserTable, MemberTable, OrgSubscriptionTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { db } from "../../db.js"
import { parseOrganizationPlan } from "../../entitlements.js"

// A transparent heuristic, not an employer directory. A verified address on an
// unlisted domain is a signal only; never merge organizations by email domain.
export const PERSONAL_EMAIL_DOMAINS = [
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "yahoo.co.jp", "ymail.com", "rocketmail.com",
  "outlook.com", "hotmail.com", "hotmail.co.uk", "hotmail.fr", "live.com", "live.co.uk", "live.fr", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "aim.com", "proton.me", "protonmail.com", "pm.me",
  "tuta.com", "tuta.io", "tutanota.com", "tutanota.de", "fastmail.com", "fastmail.fm", "hey.com",
  "mail.com", "email.com", "gmx.com", "gmx.net", "gmx.de", "web.de", "yandex.com", "yandex.ru", "ya.ru",
  "mail.ru", "inbox.ru", "bk.ru", "list.ru", "qq.com", "foxmail.com", "163.com", "126.com",
  "naver.com", "daum.net", "hanmail.net", "zoho.com", "rediffmail.com", "yopmail.com", "mailinator.com",
]

/** The verified, non-personal email domain of an account, or null. */
export function companyDomainSql() {
  const domain = sql<string>`lower(trim(substring_index(${AuthUserTable.email}, '@', -1)))`
  const personalDomains = sql.join(PERSONAL_EMAIL_DOMAINS.map((value) => sql`${value}`), sql`, `)
  return sql<string | null>`case when ${AuthUserTable.emailVerified} = true
    and ${AuthUserTable.email} regexp '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
    and ${domain} not in (${personalDomains}) then ${domain} else null end`
}

type OrganizationIdColumn = SQL | typeof OrganizationTable.id | typeof MemberTable.organizationId

/** 1 when the organization has a current active subscription. Trials are not paying. */
export function payingSql(organizationId: OrganizationIdColumn, now: Date) {
  return sql<number>`exists(select 1 from ${OrgSubscriptionTable} where ${OrgSubscriptionTable.organization_id} = ${organizationId}
    and ${OrgSubscriptionTable.status} = 'active' and (${OrgSubscriptionTable.current_period_end} is null or ${OrgSubscriptionTable.current_period_end} >= ${now}))`
}

/** 1 when a platform admin recorded outreach, a reply or a meeting for the organization. */
export function contactedSql(organizationId: OrganizationIdColumn) {
  return sql<number>`exists(select 1 from ${AccountFollowUpTable} where ${AccountFollowUpTable.organizationId} = ${organizationId}
    and (${AccountFollowUpTable.lastContactedAt} is not null or ${AccountFollowUpTable.stage} in ('contacted', 'engaged')))`
}

type Billing = { plan: "free" | "team" | "enterprise", paying: boolean, modelsAddOn: boolean }
type Outreach = { status: "not_contacted" | "contacted", lastContactedAt: string | null }

/** Plan, paid status and recorded outreach for a bounded set of organizations. Never calls Stripe. */
export async function readOrganizationSignals(ids: string[], now: Date) {
  const signals = new Map<string, { billing: Billing, outreach: Outreach }>()
  if (!ids.length) return signals
  const typed = ids as (typeof OrganizationTable.$inferSelect.id)[]
  const [organizations, subscriptions, followUps] = await Promise.all([
    db.select({ id: OrganizationTable.id, metadata: OrganizationTable.metadata }).from(OrganizationTable).where(inArray(OrganizationTable.id, typed)),
    db.select({ organizationId: OrgSubscriptionTable.organization_id, type: OrgSubscriptionTable.type, status: OrgSubscriptionTable.status, currentPeriodEnd: OrgSubscriptionTable.current_period_end })
      .from(OrgSubscriptionTable).where(inArray(OrgSubscriptionTable.organization_id, typed)),
    db.select({ organizationId: AccountFollowUpTable.organizationId, stage: AccountFollowUpTable.stage, lastContactedAt: AccountFollowUpTable.lastContactedAt })
      .from(AccountFollowUpTable).where(inArray(AccountFollowUpTable.organizationId, typed)),
  ])
  for (const organization of organizations) {
    const current = subscriptions.filter(row => row.organizationId === organization.id && (!row.currentPeriodEnd || row.currentPeriodEnd >= now))
    const followUp = followUps.find(row => row.organizationId === organization.id)
    const contacted = Boolean(followUp?.lastContactedAt) || followUp?.stage === "contacted" || followUp?.stage === "engaged"
    signals.set(organization.id, {
      billing: {
        plan: parseOrganizationPlan(organization.metadata).tier,
        paying: current.some(row => row.status === "active"),
        modelsAddOn: current.some(row => row.type === "inference" && (row.status === "active" || row.status === "trialing")),
      },
      outreach: { status: contacted ? "contacted" : "not_contacted", lastContactedAt: followUp?.lastContactedAt?.toISOString() ?? null },
    })
  }
  return signals
}

export const DEFAULT_SIGNALS = { billing: { plan: "free" as const, paying: false, modelsAddOn: false }, outreach: { status: "not_contacted" as const, lastContactedAt: null } }
