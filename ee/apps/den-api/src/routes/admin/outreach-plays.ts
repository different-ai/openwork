import { OUTREACH_PLAYS, type AdminOutreach, type OutreachItem, type OutreachPlay } from "@openwork/types/den/admin-organization"

const DAY = 86_400_000
/** Activity is counted over this many days; an account contacted this recently waits instead of being listed again. */
export const OUTREACH_WINDOW_DAYS = 14
export const FREE_LIMIT_DAYS = 7
export const CANCELED_DAYS = 30
/** How far back "used to run tasks" looks, and how long results of recorded contacts are counted. */
export const HISTORY_DAYS = 60
export const RESULT_DAYS = 30
/** A lapsed account must have run tasks on this many days before it went quiet. */
const REGULAR_DAYS = 3
const PER_PLAY = 50

type FollowUp = NonNullable<OutreachItem["followUp"]>
type Billing = OutreachItem["billing"]

export type OutreachPerson = {
  userId: string, name: string | null, email: string, role: string,
  /** UTC days in the window on which this person ran a task. */
  activeDays: number,
  /** Verified, non-personal email domain, or null. */
  companyDomain: string | null,
  /** Times this person reached the free model limit in the last week. */
  limitHits: number,
  /** Days with a task between the start of history and the start of the window. */
  beforeDays: number,
  /** Tasks started and failed in that earlier period. */
  startedBefore: number, failedBefore: number,
  lastActiveAt: Date | null, lastLimitAt: Date | null,
}

export type OutreachSubscription = {
  type: "inference" | "seat" | "web" | "enterprise", status: string, paymentFailed: boolean,
  cancelAtPeriodEnd: boolean, currentPeriodEnd: Date | null, canceledAt: Date | null, createdAt: Date,
}

export type OutreachFacts = {
  id: string, name: string, plan: Billing["plan"], members: number, seatLimit: number,
  people: OutreachPerson[], subscriptions: OutreachSubscription[], followUp: FollowUp | null,
  /** UTC days (YYYY-MM-DD) with a task, loaded only for accounts with a recorded contact. */
  activeDates: string[],
}

/** People at one verified company domain who ran tasks in the window from separate workspaces. */
export type CompanyCluster = { domain: string, users: number, organizations: number, homeOrganizationId: string, others: OutreachPerson[] }

const PRODUCT: Record<OutreachSubscription["type"], string> = { seat: "Team plan", inference: "Models add-on", web: "OpenWork Web", enterprise: "Enterprise plan" }
const day = (value: Date) => value.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
const people = (value: number) => `${value} ${value === 1 ? "person" : "people"}`
const current = (subscription: OutreachSubscription) => subscription.status === "active" || subscription.status === "trialing"
const isOwner = (person: OutreachPerson) => person.role.includes("owner")
const byActivity = (a: OutreachPerson, b: OutreachPerson) => b.activeDays - a.activeDays || Number(isOwner(b)) - Number(isOwner(a)) || a.userId.localeCompare(b.userId)

type Reason = { play: OutreachPlay, text: string, endsAt: Date | null, company: string | null, contact: OutreachPerson | null, others: OutreachPerson[], weight?: number }

/** Every reason to write to one account, strongest first. Plain rules over dated facts; no score. */
export function reasonsFor(facts: OutreachFacts, cluster: CompanyCluster | null, now: Date): Reason[] {
  const active = facts.people.filter(person => person.activeDays > 0).sort(byActivity)
  const owner = facts.people.find(isOwner) ?? facts.people.find(person => person.role.includes("admin")) ?? null
  // Money questions go to whoever owns the workspace; usage questions to whoever uses it most.
  const payer = owner ?? active[0] ?? facts.people[0] ?? null
  const user = active[0] ?? owner ?? facts.people[0] ?? null
  const rest = (contact: OutreachPerson | null) => [...active, ...facts.people.filter(person => person.activeDays === 0 && isOwner(person))]
    .filter(person => person.userId !== contact?.userId).slice(0, 5)
  const reasons: Reason[] = []
  const add = (play: OutreachPlay, text: string, contact: OutreachPerson | null, extra: Partial<Reason> = {}) =>
    reasons.push({ play, text, endsAt: null, company: null, contact, others: rest(contact), ...extra })
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY

  const due = facts.followUp?.nextFollowUpAt ? new Date(facts.followUp.nextFollowUpAt) : null
  if (due && due.getTime() < tomorrow) {
    const contacted = facts.followUp?.lastContactedAt ? new Date(facts.followUp.lastContactedAt) : null
    const back = contacted ? contactResult(facts, contacted).activeAgainAt : null
    add("follow_up", contacted && back ? `Running tasks again since ${day(back)}, after you wrote on ${day(contacted)}`
      : contacted ? `No reply recorded since you wrote on ${day(contacted)}` : `Follow-up due ${day(due)}${facts.followUp?.nextAction ? `: ${facts.followUp.nextAction}` : ""}`, user)
  }

  for (const subscription of facts.subscriptions) {
    const product = PRODUCT[subscription.type]
    if (subscription.status === "past_due" || subscription.status === "unpaid" || (current(subscription) && subscription.paymentFailed)) {
      add("payment", `Payment failed for the ${product}`, payer)
    } else if (current(subscription) && subscription.cancelAtPeriodEnd && subscription.currentPeriodEnd && subscription.currentPeriodEnd > now) {
      add("cancelling", `${product} set to end ${day(subscription.currentPeriodEnd)}`, payer, { endsAt: subscription.currentPeriodEnd })
    } else if (subscription.status === "canceled" && subscription.canceledAt && now.getTime() - subscription.canceledAt.getTime() <= CANCELED_DAYS * DAY) {
      add("cancelling", `Canceled the ${product} on ${day(subscription.canceledAt)}`, payer, { endsAt: subscription.canceledAt })
    }
  }

  const teamPlan = facts.plan === "enterprise" || facts.subscriptions.some(subscription => current(subscription) && (subscription.type === "seat" || subscription.type === "enterprise"))
  if (active.length >= 2 && !teamPlan) add("team_no_plan", `${people(active.length)} ran tasks in the last ${OUTREACH_WINDOW_DAYS} days, no Team plan`, user)
  if (facts.seatLimit > 1 && facts.members >= facts.seatLimit && facts.plan !== "enterprise") {
    add("seats_full", `All ${facts.seatLimit} seats are in use`, payer)
  }
  if (cluster) {
    const here = active.filter(person => person.companyDomain === cluster.domain)
    const contact = here[0] ?? user
    reasons.push({
      play: "company", text: `${people(cluster.users)} at ${cluster.domain} ran tasks in ${cluster.organizations} separate workspaces`,
      endsAt: null, company: cluster.domain, contact, others: cluster.others.filter(person => person.userId !== contact?.userId).slice(0, 5),
    })
  }
  const models = facts.subscriptions.some(subscription => current(subscription) && subscription.type === "inference")
  const earlier = facts.people.filter(person => person.beforeDays > 0).sort((a, b) => b.beforeDays - a.beforeDays || a.userId.localeCompare(b.userId))
  const stopped = earlier.filter(person => person.activeDays === 0 && person.beforeDays >= REGULAR_DAYS)
  if (active.length > 0 && earlier.length >= 2 && stopped.length > 0) {
    reasons.push({
      play: "shrinking", text: `${stopped.length} of the ${people(earlier.length)} who used it stopped in the last ${OUTREACH_WINDOW_DAYS} days`,
      endsAt: null, company: null, contact: user, others: [...stopped, ...active].filter(person => person.userId !== user?.userId).slice(0, 5),
    })
  }
  const limited = facts.people.filter(person => person.limitHits > 0).sort((a, b) => b.limitHits - a.limitHits || byActivity(a, b))[0]
  if (limited && !models) {
    const who = limited.name?.trim().split(/\s+/)[0] || "A member"
    add("free_limit", `${who} reached the free model limit ${limited.limitHits === 1 ? "once" : `${limited.limitHits} times`} in the last ${FREE_LIMIT_DAYS} days`, limited)
  }
  const paid = facts.subscriptions.filter(subscription => current(subscription) && now.getTime() - subscription.createdAt.getTime() > OUTREACH_WINDOW_DAYS * DAY)
  if (paid.length && active.length === 0) {
    add("quiet_paying", `Paying for the ${paid.map(subscription => PRODUCT[subscription.type]).join(" and ")}, no tasks seen in ${OUTREACH_WINDOW_DAYS} days`, payer)
  }
  const champion = earlier[0]
  if (active.length === 0 && champion && champion.beforeDays >= REGULAR_DAYS) {
    const last = Math.max(...earlier.map(person => person.lastActiveAt?.getTime() ?? 0))
    const ago = Math.max(OUTREACH_WINDOW_DAYS, Math.floor((now.getTime() - last) / DAY))
    const started = earlier.reduce((sum, person) => sum + person.startedBefore, 0)
    const failed = earlier.reduce((sum, person) => sum + person.failedBefore, 0)
    const limitAt = Math.max(0, ...facts.people.map(person => person.lastLimitAt?.getTime() ?? 0))
    // The most recently lapsed come first: they are the likeliest to come back.
    const lapsed = (play: OutreachPlay, text: string) => reasons.push({
      play, text, endsAt: null, company: null, contact: champion, others: rest(champion), weight: earlier.length * 100 + champion.beforeDays - ago * 3,
    })
    const who = earlier.length >= 2 ? `${people(earlier.length)} used it` : `${champion.name?.trim().split(/\s+/)[0] || "One person"} used it on ${champion.beforeDays} days`
    if (started >= 5 && failed / started >= 0.3) lapsed("lapsed_failed", `Stopped ${ago} days ago after ${failed} of ${started} tasks failed`)
    else if (!models && limitAt && limitAt >= last - 7 * DAY) lapsed("lapsed_limit", `Stopped ${ago} days ago, right after reaching the free model limit`)
    else if (earlier.length >= 2 || champion.companyDomain) lapsed("lapsed", `${who}, then nobody for ${ago} days`)
  }
  return reasons.sort((a, b) => OUTREACH_PLAYS.indexOf(a.play) - OUTREACH_PLAYS.indexOf(b.play))
}

const utcDay = (value: Date) => value.toISOString().slice(0, 10)
/** Whether an account was quiet when it was contacted, and the first day someone ran a task afterwards. */
export function contactResult(facts: Pick<OutreachFacts, "activeDates">, contacted: Date) {
  const on = utcDay(contacted), from = utcDay(new Date(contacted.getTime() - OUTREACH_WINDOW_DAYS * DAY))
  const after = facts.activeDates.filter(date => date > on).sort()[0]
  return { quiet: !facts.activeDates.some(date => date >= from && date <= on), activeAgainAt: after ? new Date(`${after}T00:00:00.000Z`) : null }
}

function billingOf(facts: OutreachFacts): Billing {
  const live = facts.subscriptions.filter(current)
  return { plan: facts.plan, paying: live.some(subscription => subscription.status === "active"), modelsAddOn: live.some(subscription => subscription.type === "inference") }
}

/**
 * The list a person works through: one row per account, under its strongest reason,
 * with the person to write to. Dismissed and closed accounts are left out, and an
 * account written to in the last two weeks waits for its follow-up date instead.
 */
export function buildOutreach(all: OutreachFacts[], clusters: CompanyCluster[], now: Date): Pick<AdminOutreach, "items" | "totals" | "waiting" | "hidden" | "results"> {
  const clusterOf = new Map(clusters.map(cluster => [cluster.homeOrganizationId, cluster]))
  const ranked: { item: OutreachItem, weight: number }[] = []
  const waiting: AdminOutreach["waiting"] = []
  let hidden = 0
  const results = { days: RESULT_DAYS, contacted: 0, replied: 0, quietWhenContacted: 0, cameBack: 0 }
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY
  for (const facts of all) {
    const reasons = reasonsFor(facts, clusterOf.get(facts.id) ?? null, now)
    const followUp = facts.followUp
    const contacted = followUp?.lastContactedAt ? new Date(followUp.lastContactedAt) : null
    const due = followUp?.nextFollowUpAt ? new Date(followUp.nextFollowUpAt) : null
    const result = contacted ? contactResult(facts, contacted) : null
    if (contacted && result && now.getTime() - contacted.getTime() <= RESULT_DAYS * DAY) {
      results.contacted += 1
      if (followUp?.stage === "engaged") results.replied += 1
      if (result.quiet) results.quietWhenContacted += 1
      if (result.quiet && result.activeAgainAt) results.cameBack += 1
    }
    if (followUp?.stage === "closed" || followUp?.stage === "dismissed") { if (reasons.length) hidden += 1; continue }
    const recent = contacted !== null && now.getTime() - contacted.getTime() < OUTREACH_WINDOW_DAYS * DAY
    if ((recent || due) && !(due && due.getTime() < tomorrow)) {
      waiting.push({ organizationId: facts.id, organizationName: facts.name, contactedAt: (contacted ?? new Date(followUp?.updatedAt ?? now)).toISOString(), ownerName: followUp?.ownerName ?? null, followUpAt: due?.toISOString() ?? null, activeAgainAt: result?.activeAgainAt?.toISOString() ?? null })
      continue
    }
    const [first, ...rest] = reasons
    if (!first) continue
    const active = facts.people.filter(person => person.activeDays > 0).length
    const lastActive = Math.max(0, ...facts.people.map(person => person.lastActiveAt?.getTime() ?? 0))
    const strip = ({ userId, name, email, role, activeDays }: OutreachPerson) => ({ userId, name, email, role, activeDays })
    ranked.push({
      // Within a reason: more people using it first, then a work address, then how often the contact uses it.
      weight: first.weight ?? (first.play === "company" ? clusterOf.get(facts.id)?.users ?? 0 : active) * 100 + (first.contact?.companyDomain ? 50 : 0) + (first.contact?.activeDays ?? 0),
      item: {
        organizationId: facts.id, organizationName: facts.name, play: first.play, reason: first.text,
        also: rest.map(reason => reason.text).slice(0, 6), company: first.company ?? first.contact?.companyDomain ?? null,
        contact: first.contact ? strip(first.contact) : null, others: first.others.map(strip),
        people: { members: facts.members, active }, billing: billingOf(facts), endsAt: first.endsAt?.toISOString() ?? null,
        lastActiveAt: lastActive ? new Date(lastActive).toISOString() : null, followUp,
      },
    })
  }
  ranked.sort((a, b) => OUTREACH_PLAYS.indexOf(a.item.play) - OUTREACH_PLAYS.indexOf(b.item.play) || b.weight - a.weight || a.item.organizationId.localeCompare(b.item.organizationId))
  const totals = Object.fromEntries(OUTREACH_PLAYS.map(play => [play, 0])) as Record<OutreachPlay, number>
  const items: OutreachItem[] = []
  for (const { item } of ranked) {
    totals[item.play] += 1
    if (totals[item.play] <= PER_PLAY) items.push(item)
  }
  waiting.sort((a, b) => (a.followUpAt ?? a.contactedAt).localeCompare(b.followUpAt ?? b.contactedAt))
  return { items, totals, waiting: waiting.slice(0, 50), hidden, results }
}

type ActivityRow = { organizationId: string, userId: string, activeDays: number, companyDomain: string | null }
export type ClusterSeed = Omit<CompanyCluster, "others"> & { others: { organizationId: string, userId: string }[] }

/** Company domains with people running tasks from at least two workspaces. The busiest person's workspace is the one listed. */
export function companyClusters(rows: ActivityRow[]): ClusterSeed[] {
  const byDomain = new Map<string, ActivityRow[]>()
  for (const row of rows) {
    if (!row.companyDomain || row.activeDays === 0) continue
    byDomain.set(row.companyDomain, [...byDomain.get(row.companyDomain) ?? [], row])
  }
  const clusters: ClusterSeed[] = []
  for (const [domain, members] of byDomain) {
    const users = new Set(members.map(member => member.userId)).size
    const organizations = new Set(members.map(member => member.organizationId)).size
    if (users < 2 || organizations < 2) continue
    members.sort((a, b) => b.activeDays - a.activeDays || a.userId.localeCompare(b.userId))
    const home = members[0]
    if (!home) continue
    clusters.push({
      domain, users, organizations, homeOrganizationId: home.organizationId,
      others: members.filter(member => member.organizationId !== home.organizationId).slice(0, 5).map(({ organizationId, userId }) => ({ organizationId, userId })),
    })
  }
  return clusters
}
