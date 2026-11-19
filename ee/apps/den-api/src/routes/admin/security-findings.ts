import { isIP } from "node:net"

// Transparent, threshold-based detections for the platform admin Security page.
// Every finding states its rule so a reviewer can tell why it fired; none of them
// is a verdict, and none takes an action on an account.

export type SecuritySeverity = "high" | "medium" | "low" | "clear"
export type SecurityCategory = "access" | "accounts" | "automation" | "credentials" | "usage"
export type SecurityUnit = "count" | "micro_usd"
export type SecurityTarget = { type: "user"; userId: string } | { type: "organization"; organizationId: string } | null

export type SecurityEntity = {
  id: string
  label: string
  detail: string | null
  value: number
  severity: SecuritySeverity
  target: SecurityTarget
}

export type SecurityFinding = {
  id: string
  category: SecurityCategory
  severity: SecuritySeverity
  title: string
  summary: string
  rule: string
  why: string
  review: string
  value: number
  unit: SecurityUnit
  entities: SecurityEntity[]
  /** Matching entities, including any past the listed cap. */
  entityCount: number
}

/** Entities listed per finding; the rest are only counted. */
export const SECURITY_ENTITY_LIMIT = 20

const SEVERITY_RANK: Record<SecuritySeverity, number> = { high: 3, medium: 2, low: 1, clear: 0 }

export function highestSeverity(values: readonly SecuritySeverity[]): SecuritySeverity {
  return values.reduce<SecuritySeverity>((top, value) => SEVERITY_RANK[value] > SEVERITY_RANK[top] ? value : top, "clear")
}

export function sortFindings(findings: readonly SecurityFinding[]): SecurityFinding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`
}

function usd(microUsd: number) {
  return `$${(microUsd / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function finding(base: Omit<SecurityFinding, "severity" | "entityCount">): SecurityFinding {
  return {
    ...base,
    severity: highestSeverity(base.entities.map((entity) => entity.severity)),
    entities: [...base.entities].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.value - a.value).slice(0, SECURITY_ENTITY_LIMIT),
    entityCount: base.entities.length,
  }
}

function tiered(value: number, tiers: { high?: number; medium?: number; low?: number }): SecuritySeverity {
  if (tiers.high !== undefined && value >= tiers.high) return "high"
  if (tiers.medium !== undefined && value >= tiers.medium) return "medium"
  if (tiers.low !== undefined && value >= tiers.low) return "low"
  return "clear"
}

function expandIpv6(address: string): string[] | null {
  const [head = "", tail, extra] = address.split("::")
  if (extra !== undefined) return null
  const left = head ? head.split(":") : []
  const right = tail ? tail.split(":") : []
  const missing = 8 - left.length - right.length
  if (tail === undefined ? missing !== 0 : missing < 1) return null
  return [...left, ...Array.from({ length: tail === undefined ? 0 : missing }, () => "0"), ...right]
}

/**
 * The network a sign-in came from: IPv4 /24 or IPv6 /64. Coarse on purpose, so
 * a page never needs a full address and one home or office reads as one place.
 */
export function networkOf(ip: string | null | undefined): string | null {
  const value = ip?.trim().toLowerCase() ?? ""
  const mapped = value.startsWith("::ffff:") && isIP(value.slice(7)) === 4 ? value.slice(7) : value
  if (isIP(mapped) === 4) return `${mapped.split(".").slice(0, 3).join(".")}.0/24`
  if (isIP(mapped) !== 6) return null
  const groups = expandIpv6(mapped.split("%")[0] ?? "")
  if (!groups) return null
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@")
  const domain = at > 0 ? email.slice(at + 1).trim().toLowerCase() : ""
  return /^[^@\s]+\.[^@\s]+$/.test(domain) ? domain : null
}

function emailSample(emails: readonly string[]) {
  const shown = emails.slice(0, 3).join(", ")
  return emails.length > 3 ? `${shown} and ${emails.length - 3} more` : shown
}

// ── Accounts ────────────────────────────────────────────────────────────────

export type NewAccount = { userId: string; email: string; emailVerified: boolean; createdAt: Date; network: string | null }

export const SIGNUP_NETWORK_TIERS = { high: 15, medium: 5 }

/** Many new accounts from one network. One company domain making most of them reads as a team joining. */
export function signupNetworkFinding(accounts: readonly NewAccount[], personalDomains: ReadonlySet<string>): SecurityFinding {
  const byNetwork = new Map<string, NewAccount[]>()
  for (const account of accounts) {
    if (!account.network) continue
    byNetwork.set(account.network, [...(byNetwork.get(account.network) ?? []), account])
  }
  const entities: SecurityEntity[] = []
  for (const [network, members] of byNetwork) {
    let severity = tiered(members.length, SIGNUP_NETWORK_TIERS)
    if (severity === "clear") continue
    const domains = new Map<string, number>()
    for (const member of members) {
      const domain = emailDomain(member.email)
      if (domain && member.emailVerified && !personalDomains.has(domain)) domains.set(domain, (domains.get(domain) ?? 0) + 1)
    }
    const [teamDomain, teamCount] = [...domains.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0]
    const team = teamDomain !== null && teamCount / members.length >= 0.8
    if (team) severity = "low"
    const verified = members.filter((member) => member.emailVerified).length
    entities.push({
      id: network, label: network, value: members.length, severity, target: null,
      detail: `${team ? `Mostly verified ${teamDomain} addresses. ` : ""}${plural(verified, "verified address", "verified addresses")}: ${emailSample(members.map((member) => member.email))}`,
    })
  }
  return finding({
    id: "signup-networks", category: "accounts", title: "Sign-up bursts from one network",
    summary: entities.length ? `${plural(entities.length, "network")} created ${SIGNUP_NETWORK_TIERS.medium} or more accounts.` : "No network created more than a few accounts.",
    rule: `Flags a network (IPv4 /24 or IPv6 /64 of each account's first sign-in) with ${SIGNUP_NETWORK_TIERS.medium}+ new accounts; ${SIGNUP_NETWORK_TIERS.high}+ is high. When 80% or more share one verified company domain it is low.`,
    why: "Scripted sign-ups usually come from one place. They farm free allowances, test stolen cards or prepare accounts for spam.",
    review: "Open the accounts. Look for random names, sequential addresses and accounts that never did real work.",
    value: entities.reduce((total, entity) => total + entity.value, 0), unit: "count", entities,
  })
}

export const UNVERIFIED_TIERS = { highShare: 0.25, highCount: 50, mediumShare: 0.1, mediumCount: 20 }

/** The share of new accounts that never confirmed their email, against the previous window. */
export function unverifiedSignupFinding(accounts: readonly NewAccount[], previous: { total: number; unverified: number }): SecurityFinding {
  const unverified = accounts.filter((account) => !account.emailVerified)
  const share = accounts.length ? unverified.length / accounts.length : 0
  const previousShare = previous.total ? previous.unverified / previous.total : 0
  const rising = share >= Math.max(previousShare * 2, 0.02)
  const severity: SecuritySeverity = unverified.length >= UNVERIFIED_TIERS.highCount && share >= UNVERIFIED_TIERS.highShare ? "high"
    : unverified.length >= UNVERIFIED_TIERS.mediumCount && share >= UNVERIFIED_TIERS.mediumShare && rising ? "medium"
      : unverified.length >= 10 && rising ? "low" : "clear"
  const percent = (value: number) => `${Math.round(value * 100)}%`
  return {
    id: "unverified-signups", category: "accounts", severity, title: "Unverified sign-ups",
    summary: `${plural(unverified.length, "new account")} never confirmed an email (${percent(share)}, previously ${percent(previousShare)}).`,
    rule: `Medium when ${UNVERIFIED_TIERS.mediumCount}+ accounts and ${percent(UNVERIFIED_TIERS.mediumShare)}+ of sign-ups are unverified and the share at least doubled; high at ${UNVERIFIED_TIERS.highCount}+ and ${percent(UNVERIFIED_TIERS.highShare)}+.`,
    why: "Bots rarely finish email confirmation. A rising unverified share is an early sign of automated sign-ups.",
    review: "Compare with the sign-up network and domain findings to see where they came from.",
    value: unverified.length, unit: "count", entityCount: 0, entities: [],
  }
}

export const DISPOSABLE_EMAIL_DOMAINS = [
  "mailinator.com", "yopmail.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com", "grr.la", "10minutemail.com",
  "temp-mail.org", "tempmail.com", "tempmail.dev", "tempmailo.com", "throwawaymail.com", "trashmail.com", "getnada.com",
  "dispostable.com", "maildrop.cc", "mailnesia.com", "mohmal.com", "emailondeck.com", "fakeinbox.com", "mintemail.com",
  "spamgourmet.com", "mytemp.email", "tempr.email", "discard.email", "burnermail.io", "inboxkitten.com", "1secmail.com",
]
export const DISPOSABLE_TIERS = { high: 20, medium: 5, low: 1 }

export function disposableSignupFinding(accounts: readonly NewAccount[]): SecurityFinding {
  const disposable = new Set(DISPOSABLE_EMAIL_DOMAINS)
  const byDomain = new Map<string, string[]>()
  for (const account of accounts) {
    const domain = emailDomain(account.email)
    if (domain && disposable.has(domain)) byDomain.set(domain, [...(byDomain.get(domain) ?? []), account.email])
  }
  const total = [...byDomain.values()].reduce((sum, emails) => sum + emails.length, 0)
  const severity = tiered(total, DISPOSABLE_TIERS)
  return finding({
    id: "disposable-signups", category: "accounts", title: "Disposable email sign-ups",
    summary: total ? `${plural(total, "new account")} used a throwaway inbox.` : "No new account used a known throwaway inbox.",
    rule: `Lists sign-ups on ${DISPOSABLE_EMAIL_DOMAINS.length} known disposable inbox domains; ${DISPOSABLE_TIERS.medium}+ is medium, ${DISPOSABLE_TIERS.high}+ is high.`,
    why: "Throwaway inboxes let one person open many accounts and leave no way to reach them.",
    review: "Check whether these accounts used free allowances or invited others.",
    value: total, unit: "count",
    entities: [...byDomain].map(([domain, emails]) => ({ id: domain, label: domain, detail: emailSample(emails), value: emails.length, severity, target: null })),
  })
}

export type UnverifiedDomainCount = { domain: string; unverified: number; total: number }
export const UNVERIFIED_DOMAIN_TIERS = { high: 20, medium: 5 }

/** Company-looking domains with many unconfirmed sign-ups; personal and disposable domains are covered elsewhere. */
export function unverifiedDomainFinding(rows: readonly UnverifiedDomainCount[], excluded: ReadonlySet<string>): SecurityFinding {
  const entities = rows.filter((row) => !excluded.has(row.domain)).flatMap((row): SecurityEntity[] => {
    const severity = tiered(row.unverified, UNVERIFIED_DOMAIN_TIERS)
    return severity === "clear" ? [] : [{ id: row.domain, label: row.domain, detail: `${row.unverified} of ${plural(row.total, "new account")} unverified`, value: row.unverified, severity, target: null }]
  })
  return finding({
    id: "unverified-domains", category: "accounts", title: "Unverified sign-ups on one domain",
    summary: entities.length ? `${plural(entities.length, "domain")} had ${UNVERIFIED_DOMAIN_TIERS.medium}+ unverified sign-ups.` : "No company domain had a run of unverified sign-ups.",
    rule: `Flags a non-personal domain with ${UNVERIFIED_DOMAIN_TIERS.medium}+ unverified new accounts; ${UNVERIFIED_DOMAIN_TIERS.high}+ is high.`,
    why: "Addresses on a domain nobody controls can be invented in bulk. Real teams confirm their email.",
    review: "Check whether the domain exists and belongs to a real company before trusting these accounts.",
    value: entities.reduce((total, entity) => total + entity.value, 0), unit: "count", entities,
  })
}

export type UserNetworkSpread = { userId: string; email: string; networks: number; signIns: number; clients: number }
export const NETWORK_SPREAD_TIERS = { high: 30, medium: 15, low: 8 }

export function networkSpreadFinding(rows: readonly UserNetworkSpread[]): SecurityFinding {
  const entities = rows.flatMap((row): SecurityEntity[] => {
    const severity = tiered(row.networks, NETWORK_SPREAD_TIERS)
    return severity === "clear" ? [] : [{
      id: row.userId, label: row.email, value: row.networks, severity, target: { type: "user", userId: row.userId },
      detail: `${plural(row.networks, "network")}, ${plural(row.signIns, "sign-in")}, ${plural(row.clients, "browser or app", "browsers or apps")}`,
    }]
  })
  return finding({
    id: "network-spread", category: "accounts", title: "Accounts used from many networks",
    summary: entities.length ? `${plural(entities.length, "account")} signed in from ${NETWORK_SPREAD_TIERS.low}+ networks.` : `No account signed in from ${NETWORK_SPREAD_TIERS.low} or more networks.`,
    rule: `Counts distinct sign-in networks per account in the range; ${NETWORK_SPREAD_TIERS.low}+ is low, ${NETWORK_SPREAD_TIERS.medium}+ medium, ${NETWORK_SPREAD_TIERS.high}+ high.`,
    why: "A shared or stolen login is used from many places at once. People who travel or use mobile data also move between networks.",
    review: "Look for many browsers or apps at once and for networks far apart. Ask the owner or end their sessions if it looks shared.",
    value: entities.length, unit: "count", entities,
  })
}

export type OrganizationCreator = { userId: string; email: string; organizations: number }
export const ORGANIZATION_CREATION_TIERS = { high: 15, medium: 5 }

export function organizationCreationFinding(rows: readonly OrganizationCreator[]): SecurityFinding {
  const entities = rows.flatMap((row): SecurityEntity[] => {
    const severity = tiered(row.organizations, ORGANIZATION_CREATION_TIERS)
    return severity === "clear" ? [] : [{ id: row.userId, label: row.email, detail: `Owner of ${plural(row.organizations, "new organization")}`, value: row.organizations, severity, target: { type: "user", userId: row.userId } }]
  })
  return finding({
    id: "organization-creation", category: "accounts", title: "Many new organizations from one person",
    summary: entities.length ? `${plural(entities.length, "person", "people")} created ${ORGANIZATION_CREATION_TIERS.medium}+ organizations.` : "Nobody created more than a few organizations.",
    rule: `Counts organizations a person became the owner of in the range; ${ORGANIZATION_CREATION_TIERS.medium}+ is medium, ${ORGANIZATION_CREATION_TIERS.high}+ high.`,
    why: "Every organization starts with its own free allowances, so repeated creation can multiply them.",
    review: "Open the person and check whether the organizations hold real work or only used free model credits.",
    value: entities.length, unit: "count", entities,
  })
}

// ── Bot-like use ────────────────────────────────────────────────────────────

/** Clients that announce automation in their user agent. Mobile app stacks (okhttp, CFNetwork) are left out. */
export const AUTOMATION_CLIENTS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "Headless Chrome", pattern: /HeadlessChrome/i },
  { label: "Playwright", pattern: /Playwright/i },
  { label: "Puppeteer", pattern: /Puppeteer/i },
  { label: "Selenium or WebDriver", pattern: /Selenium|WebDriver/i },
  { label: "PhantomJS", pattern: /PhantomJS/i },
  { label: "Python script", pattern: /python-requests|python-httpx|aiohttp|python-urllib/i },
  { label: "curl or Wget", pattern: /^(?:curl|Wget)\//i },
  { label: "Go program", pattern: /Go-http-client/i },
  { label: "Scrapy", pattern: /Scrapy/i },
  { label: "Java program", pattern: /Apache-HttpClient|Java-http-client/i },
  { label: "Postman", pattern: /PostmanRuntime/i },
]

export function automationClientOf(userAgent: string | null | undefined): string | null {
  const value = userAgent?.trim() ?? ""
  return value ? AUTOMATION_CLIENTS.find((client) => client.pattern.test(value))?.label ?? null : null
}

export type AutomationSignIn = { userId: string; email: string; client: string; signIns: number; newAccount: boolean }
export const AUTOMATION_SIGN_IN_TIERS = { high: 20, medium: 3 }

export function automationClientFinding(rows: readonly AutomationSignIn[]): SecurityFinding {
  const byUser = new Map<string, { email: string; clients: Set<string>; signIns: number; newAccount: boolean }>()
  for (const row of rows) {
    const entry = byUser.get(row.userId) ?? { email: row.email, clients: new Set<string>(), signIns: 0, newAccount: row.newAccount }
    entry.clients.add(row.client)
    entry.signIns += row.signIns
    byUser.set(row.userId, entry)
  }
  const entities = [...byUser].map(([userId, entry]): SecurityEntity => {
    const severity = tiered(entry.signIns, AUTOMATION_SIGN_IN_TIERS)
    return {
      id: userId, label: entry.email, value: entry.signIns, target: { type: "user", userId },
      severity: severity === "clear" ? entry.newAccount ? "medium" : "low" : severity,
      detail: `${[...entry.clients].join(", ")}${entry.newAccount ? ", on a new account" : ""}`,
    }
  })
  return finding({
    id: "automation-clients", category: "automation", title: "Sign-ins from automation tools",
    summary: entities.length ? `${plural(entities.length, "account")} signed in with a headless browser or a script.` : "No sign-in came from a headless browser or a script.",
    rule: `Matches sign-in user agents from ${AUTOMATION_CLIENTS.map((client) => client.label).join(", ")}. Low for an existing account, medium for a new one or ${AUTOMATION_SIGN_IN_TIERS.medium}+ sign-ins, high at ${AUTOMATION_SIGN_IN_TIERS.high}+.`,
    why: "People sign in with a browser or the OpenWork app. A scripted or headless sign-in means a program is driving the account.",
    review: "Check whether it is a developer testing on purpose. Otherwise look at what the account did after signing in.",
    value: entities.length, unit: "count", entities,
  })
}

export type HourlyActivity = { userId: string; email: string; organization: string; days: number[]; automations: number }
/** Distinct active UTC hours in one day that leave no room for sleep. */
export const ROUND_THE_CLOCK_HOURS = 20
export const ROUND_THE_CLOCK_TIERS = { high: 4, medium: 2, low: 1 }

/** `days` holds the distinct active UTC hours of each active day. */
export function roundTheClockFinding(rows: readonly HourlyActivity[]): SecurityFinding {
  const entities = rows.flatMap((row): SecurityEntity[] => {
    const fullDays = row.days.filter((hours) => hours >= ROUND_THE_CLOCK_HOURS).length
    let severity = tiered(fullDays, ROUND_THE_CLOCK_TIERS)
    if (severity === "clear") return []
    if (row.automations) severity = "low"
    return [{
      id: row.userId, label: row.email, value: fullDays, severity, target: { type: "user", userId: row.userId },
      detail: `${plural(fullDays, "day")} with model use in ${ROUND_THE_CLOCK_HOURS}+ hours, busiest ${Math.max(...row.days)} of 24, in ${row.organization}${row.automations ? `. Owns ${plural(row.automations, "active automation")}` : ""}`,
    }]
  })
  return finding({
    id: "round-the-clock", category: "automation", title: "Model use around the clock",
    summary: entities.length ? `${plural(entities.length, "person", "people")} used models in ${ROUND_THE_CLOCK_HOURS} or more hours of a day.` : "Nobody used models through a whole day without a break.",
    rule: `Counts the UTC hours of each day with an OpenWork-billed model request, paid or free Auto. One day at ${ROUND_THE_CLOCK_HOURS}+ hours is low, ${ROUND_THE_CLOCK_TIERS.medium}+ days medium, ${ROUND_THE_CLOCK_TIERS.high}+ high. People who own active automations stay low.`,
    why: "People sleep. An account that works every hour of the day is usually a program or computer use running on its own, and that can farm credits or run tasks nobody watches.",
    review: "Check the account's automations and Workbot tasks first. Without them, look at the models used and whether the work looks scripted.",
    value: entities.length, unit: "count", entities,
  })
}

export type InstantAllowance = { userId: string; email: string; createdAt: Date; firstDayMicroUsd: number }

export function instantAllowanceFinding(rows: readonly InstantAllowance[], weeklyLimitMicroUsd: number): SecurityFinding {
  return finding({
    id: "instant-allowance", category: "automation", title: "Free allowance used up on day one",
    summary: rows.length ? `${plural(rows.length, "new account")} used a whole week of free Auto within a day of signing up.` : "No new account used its weekly free Auto within its first day.",
    rule: `Lists accounts created in the range whose free Auto spend in their first 24 hours reached 90% of the ${usd(weeklyLimitMicroUsd)} weekly allowance.`,
    why: "A person exploring a new product rarely spends a week of credits in a day. Scripts that sign up and drain the allowance do.",
    review: "Compare with the sign-up network and throwaway inbox findings. Several such accounts from one place point to farming.",
    value: rows.length, unit: "count",
    entities: rows.map((row) => ({
      id: row.userId, label: row.email, value: row.firstDayMicroUsd, severity: "medium", target: { type: "user", userId: row.userId },
      detail: `${usd(row.firstDayMicroUsd)} in the first day, signed up ${row.createdAt.toISOString().slice(0, 10)}`,
    })),
  })
}

// ── Credentials and privileges ──────────────────────────────────────────────

export type AdminGrant = { id: string; email: string; note: string | null; createdAt: Date }

export function adminGrantFinding(grants: readonly AdminGrant[], admins: number): SecurityFinding {
  return finding({
    id: "admin-grants", category: "credentials", title: "New platform admins",
    summary: grants.length ? `${plural(grants.length, "address", "addresses")} joined the admin allowlist, ${plural(admins, "admin")} in total.` : `No admin was added. ${plural(admins, "admin")} in total.`,
    rule: "Lists every address added to the platform admin allowlist in the range.",
    why: "Platform admins can read and change every organization. Each new admin should be expected.",
    review: "Confirm each address belongs to someone on the team and that someone asked for it.",
    value: grants.length, unit: "count",
    entities: grants.map((grant) => ({ id: grant.id, label: grant.email, detail: `Added ${grant.createdAt.toISOString().slice(0, 10)}${grant.note ? `: ${grant.note}` : ""}`, value: 1, severity: "medium", target: null })),
  })
}

export type ApiKeyOwner = { ownerId: string; label: string; keys: number; isUser: boolean }
export const API_KEY_TIERS = { high: 20, medium: 5 }

export function apiKeyFinding(owners: readonly ApiKeyOwner[], posture: { enabled: number; withoutExpiry: number }): SecurityFinding {
  const entities = owners.flatMap((owner): SecurityEntity[] => {
    const severity = tiered(owner.keys, API_KEY_TIERS)
    return severity === "clear" ? [] : [{ id: owner.ownerId, label: owner.label, detail: `Created ${plural(owner.keys, "API key")}`, value: owner.keys, severity, target: owner.isUser ? { type: "user", userId: owner.ownerId } : null }]
  })
  const lifetime = posture.withoutExpiry ? ` ${plural(posture.withoutExpiry, "enabled key")} never expire.` : ""
  return finding({
    id: "api-keys", category: "credentials", title: "API key bursts",
    summary: `${entities.length ? `${plural(entities.length, "owner")} created ${API_KEY_TIERS.medium}+ keys.` : `No owner created ${API_KEY_TIERS.medium}+ keys.`} ${plural(posture.enabled, "key")} enabled.${lifetime}`,
    rule: `Flags an owner who created ${API_KEY_TIERS.medium}+ API keys in the range; ${API_KEY_TIERS.high}+ is high.`,
    why: "Keys act without a person signing in. Many new keys can mean automation that outgrew its limits or an account handing out access.",
    review: "Check what the keys are named for and whether the owner still needs them.",
    value: entities.length, unit: "count", entities,
  })
}

export type ClientRegistrations = { current: number; previous: number; anonymous: number; byUser: Array<{ userId: string; email: string; clients: number }> }
export const CLIENT_REGISTRATION_USER_TIERS = { high: 200, medium: 50 }

export function clientRegistrationFinding(input: ClientRegistrations): SecurityFinding {
  const growth = input.previous ? input.current / input.previous : input.current ? Number.POSITIVE_INFINITY : 0
  const volume: SecuritySeverity = input.current >= 1_000 && growth >= 3 ? "high" : input.current >= 200 && growth >= 2 ? "medium" : "clear"
  const entities: SecurityEntity[] = input.byUser.flatMap((row): SecurityEntity[] => {
    const severity = tiered(row.clients, CLIENT_REGISTRATION_USER_TIERS)
    return severity === "clear" ? [] : [{ id: row.userId, label: row.email, detail: `Registered ${plural(row.clients, "app")}`, value: row.clients, severity, target: { type: "user", userId: row.userId } }]
  })
  if (volume !== "clear") entities.push({ id: "all", label: "All registrations", detail: `${plural(input.anonymous, "registration")} without a signed-in person, ${plural(input.previous, "registration")} in the previous range`, value: input.current, severity: volume, target: null })
  return finding({
    id: "client-registrations", category: "credentials", title: "App registrations",
    summary: `${plural(input.current, "app")} registered to sign in with OpenWork, previously ${input.previous.toLocaleString("en-US")}.`,
    rule: `Medium when registrations doubled to 200+, high when they tripled to 1,000+. One person registering ${CLIENT_REGISTRATION_USER_TIERS.medium}+ apps is medium.`,
    why: "MCP clients register themselves to request access. A sudden wave can be someone probing sign-in or phishing with a look-alike app.",
    review: "Check the names and redirect addresses of recent registrations for look-alikes.",
    value: input.current, unit: "count", entities,
  })
}

export type Inviter = { userId: string; email: string; invitations: number; organizations: number }
export const INVITATION_TIERS = { high: 100, medium: 25 }

export function invitationFinding(rows: readonly Inviter[]): SecurityFinding {
  const entities = rows.flatMap((row): SecurityEntity[] => {
    const severity = tiered(row.invitations, INVITATION_TIERS)
    return severity === "clear" ? [] : [{ id: row.userId, label: row.email, detail: `${plural(row.invitations, "invitation")} from ${plural(row.organizations, "organization")}`, value: row.invitations, severity, target: { type: "user", userId: row.userId } }]
  })
  return finding({
    id: "invitations", category: "credentials", title: "Invitation bursts",
    summary: entities.length ? `${plural(entities.length, "person", "people")} sent ${INVITATION_TIERS.medium}+ invitations.` : `Nobody sent ${INVITATION_TIERS.medium} or more invitations.`,
    rule: `Flags a person who sent ${INVITATION_TIERS.medium}+ invitations in the range; ${INVITATION_TIERS.high}+ is high.`,
    why: "Invitation emails come from OpenWork, so they can be abused to send spam or phishing that looks trusted.",
    review: "Check who was invited. Many unrelated domains or addresses outside the team point to abuse.",
    value: entities.length, unit: "count", entities,
  })
}

// ── Usage ───────────────────────────────────────────────────────────────────

export type OrganizationSpend = { organizationId: string; name: string; currentMicroUsd: number; previousMicroUsd: number }
export const SPEND_SPIKE = { mediumMicroUsd: 25_000_000, mediumGrowth: 3, highMicroUsd: 100_000_000, highGrowth: 10 }

export function spendSpikeFinding(rows: readonly OrganizationSpend[]): SecurityFinding {
  const entities = rows.flatMap((row): SecurityEntity[] => {
    const growth = row.previousMicroUsd ? row.currentMicroUsd / row.previousMicroUsd : Number.POSITIVE_INFINITY
    const severity: SecuritySeverity = row.currentMicroUsd >= SPEND_SPIKE.highMicroUsd && growth >= SPEND_SPIKE.highGrowth ? "high"
      : row.currentMicroUsd >= SPEND_SPIKE.mediumMicroUsd && growth >= SPEND_SPIKE.mediumGrowth ? "medium" : "clear"
    return severity === "clear" ? [] : [{
      id: row.organizationId, label: row.name, value: row.currentMicroUsd, severity, target: { type: "organization", organizationId: row.organizationId },
      detail: row.previousMicroUsd ? `${usd(row.currentMicroUsd)}, up from ${usd(row.previousMicroUsd)} (${Math.round(growth)}×)` : `${usd(row.currentMicroUsd)} with no spend in the previous range`,
    }]
  })
  return finding({
    id: "spend-spikes", category: "usage", title: "Model spend spikes",
    summary: entities.length ? `${plural(entities.length, "organization")} spent far more than in the previous range.` : "No organization's model spend jumped.",
    rule: `Compares each organization's paid and free model spend with the previous range: ${usd(SPEND_SPIKE.mediumMicroUsd)}+ and ${SPEND_SPIKE.mediumGrowth}× is medium, ${usd(SPEND_SPIKE.highMicroUsd)}+ and ${SPEND_SPIKE.highGrowth}× is high.`,
    why: "A sudden jump can be a leaked key, a runaway automation or an account reselling access.",
    review: "Open the organization's usage. Check which people and models drove it and whether the jump matches real work.",
    value: entities.length, unit: "count", entities,
  })
}

// ── Access (request log, last 24 hours) ─────────────────────────────────────

export type RequestRollupRow = { hour: number; action: string; outcome: "denied" | "failed" | "unknown"; status: number; requests: number }

export type HourlySeries = number[]

function median(values: readonly number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] ?? 0 : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/** The busiest hour against a typical one. Quiet series use a floor of 1 so a first burst still shows. */
export function spikeOf(series: HourlySeries) {
  const peak = Math.max(0, ...series)
  const typical = median(series)
  return { peak, typical, ratio: peak / Math.max(1, typical), total: series.reduce((sum, value) => sum + value, 0) }
}

export const FAILED_SIGN_IN = { highPeak: 100, highRatio: 5, mediumPeak: 30, mediumRatio: 3, lowTotal: 200 }
export const RATE_LIMITED = { highPeak: 200, highRatio: 5, mediumPeak: 50, mediumRatio: 3 }
export const DENIED_ACTION_SPIKE = { highPeak: 2_000, highRatio: 10, mediumPeak: 200, mediumRatio: 4 }

export function isSignInAction(action: string) {
  return /^auth\.sign_in\./.test(action)
}

function spikeSeverity(spike: ReturnType<typeof spikeOf>, tiers: { highPeak: number; highRatio: number; mediumPeak: number; mediumRatio: number; lowTotal?: number }): SecuritySeverity {
  if (spike.peak >= tiers.highPeak && spike.ratio >= tiers.highRatio) return "high"
  if (spike.peak >= tiers.mediumPeak && spike.ratio >= tiers.mediumRatio) return "medium"
  return tiers.lowTotal !== undefined && spike.total >= tiers.lowTotal ? "low" : "clear"
}

export function failedSignInFinding(series: HourlySeries): SecurityFinding {
  const spike = spikeOf(series)
  const severity = spikeSeverity(spike, FAILED_SIGN_IN)
  return {
    id: "failed-sign-ins", category: "access", severity, title: "Failed sign-ins",
    summary: `${plural(spike.total, "failed sign-in")} in 24 hours; the busiest hour had ${spike.peak.toLocaleString("en-US")}, a typical hour ${Math.round(spike.typical).toLocaleString("en-US")}.`,
    rule: `Medium when an hour reaches ${FAILED_SIGN_IN.mediumPeak}+ and ${FAILED_SIGN_IN.mediumRatio}× a typical hour, high at ${FAILED_SIGN_IN.highPeak}+ and ${FAILED_SIGN_IN.highRatio}×; ${FAILED_SIGN_IN.lowTotal}+ in a day is low.`,
    why: "Bursts of wrong passwords are the signature of password guessing and of logins reused from other breaches.",
    review: "Check whether the burst lines up with sign-up or rate-limit spikes. Sign-in attempts store no address, so look in the edge logs for the source.",
    value: spike.total, unit: "count", entityCount: 0, entities: [],
  }
}

export function rateLimitedFinding(byAction: ReadonlyMap<string, HourlySeries>): SecurityFinding {
  const hours = Math.max(0, ...[...byAction.values()].map((series) => series.length))
  const all = Array.from({ length: hours }, (_, index) => [...byAction.values()].reduce((sum, series) => sum + (series[index] ?? 0), 0))
  const spike = spikeOf(all)
  // The limit is shared, so the whole series decides severity and every limited endpoint carries it.
  const severity = spikeSeverity(spike, RATE_LIMITED)
  const entities = [...byAction].map(([action, series]) => ({ action, ...spikeOf(series) })).filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total)
    .map((row): SecurityEntity => ({ id: row.action, label: row.action, detail: `Busiest hour ${row.peak.toLocaleString("en-US")}`, value: row.total, severity, target: null }))
  return {
    id: "rate-limited", category: "access", severity, title: "Rate-limited requests",
    summary: `${plural(spike.total, "request")} hit a rate limit in 24 hours; the busiest hour had ${spike.peak.toLocaleString("en-US")}.`,
    rule: `Medium when an hour reaches ${RATE_LIMITED.mediumPeak}+ and ${RATE_LIMITED.mediumRatio}× a typical hour, high at ${RATE_LIMITED.highPeak}+ and ${RATE_LIMITED.highRatio}×.`,
    why: "Limits stop guessing and scraping. A jump means someone is pushing hard on a sign-in or token endpoint.",
    review: "See which endpoints are limited. Token and sign-in endpoints matter most.",
    value: spike.total, unit: "count", entities: entities.slice(0, SECURITY_ENTITY_LIMIT), entityCount: entities.length,
  }
}

export function deniedSpikeFinding(byAction: ReadonlyMap<string, HourlySeries>): SecurityFinding {
  const entities = [...byAction].flatMap(([action, series]): SecurityEntity[] => {
    const spike = spikeOf(series)
    const severity = spikeSeverity(spike, DENIED_ACTION_SPIKE)
    return severity === "clear" ? [] : [{ id: action, label: action, detail: `Busiest hour ${spike.peak.toLocaleString("en-US")}, typical ${Math.round(spike.typical).toLocaleString("en-US")} (${Math.round(spike.ratio)}×)`, value: spike.peak, severity, target: null }]
  })
  return finding({
    id: "denied-spikes", category: "access", title: "Refused request spikes",
    summary: entities.length ? `${plural(entities.length, "endpoint")} refused far more requests than usual in one hour.` : "Refused requests stayed at their usual hourly level.",
    rule: `Flags an endpoint whose busiest hour of refused or failed requests is ${DENIED_ACTION_SPIKE.mediumPeak}+ and ${DENIED_ACTION_SPIKE.mediumRatio}× its typical hour; ${DENIED_ACTION_SPIKE.highPeak}+ and ${DENIED_ACTION_SPIKE.highRatio}× is high. Steady pollers do not fire.`,
    why: "A burst of refusals on one endpoint is what scanning, enumeration or a leaked-but-revoked credential looks like.",
    review: "Match the hour with deploys first; a release can briefly reject valid callers. Otherwise look in the edge logs for the source.",
    value: entities.length, unit: "count", entities,
  })
}
