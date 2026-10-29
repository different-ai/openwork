import { OPPORTUNITY_KINDS, type AdminOpportunityAccount, type OpportunityItem } from "@openwork/types/den/admin-organization"

const DAY = 86_400_000
const PRIORITY = { high: 3, medium: 2, low: 1 } as const
type Priority = keyof typeof PRIORITY
type Kind = OpportunityItem["kind"]
type Signal = OpportunityItem["signals"][number]
type FollowUp = NonNullable<OpportunityItem["followUp"]>

/** Repeated outreach inside this window is demoted, not recommended. */
export const RECENT_CONTACT_DAYS = 14

export type OrganizationFacts = {
  id: string, name: string, createdAt: Date, members: number, seatLimit: number,
  joinedThisWeek: number, latestJoinAt: Date | null,
  activeCurrent: number, activePrevious: number, lastObservedAt: Date | null,
  skills: number, mcpConnections: number,
  subscriptions: { status: string, cancelAtPeriodEnd: boolean, currentPeriodEnd: Date | null }[],
  signups: { userId: string, name: string, createdAt: Date }[],
  followUp: FollowUp | null,
}

const day = (value: Date) => value.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
const plural = (value: number, word: string) => `${value} ${word}${value === 1 ? "" : "s"}`
export const startOfUtcDay = (value: Date) => new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))

export function adoptionOf(facts: OrganizationFacts): AdminOpportunityAccount["adoption"] {
  const stage = facts.activeCurrent >= 2 ? (facts.joinedThisWeek > 0 ? "expanding" : "team")
    : facts.activeCurrent === 1 ? "individual" : facts.lastObservedAt ? "quiet_this_week" : "no_observed_use"
  return {
    stage, members: facts.members, joinedThisWeek: facts.joinedThisWeek,
    activeUsers: { current: facts.activeCurrent, previous: facts.activePrevious },
    lastObservedAt: facts.lastObservedAt?.toISOString() ?? null, skills: facts.skills, mcpConnections: facts.mcpConnections,
  }
}

/**
 * Transparent rules, not a score. Each recommendation keeps the dated facts that
 * produced it. Missing telemetry is reported as "no observed use", never as
 * inactivity; an email domain is never treated as employment.
 */
export function buildOpportunity(facts: OrganizationFacts, now: Date): OpportunityItem | null {
  const found: { kind: Kind, priority: Priority, signal: Signal }[] = []
  const add = (kind: Kind, priority: Priority, type: Signal["type"], label: string, at: Date | null, userId: string | null = null) =>
    found.push({ kind, priority, signal: { type, label, at: at?.toISOString() ?? null, userId } })
  const tomorrow = startOfUtcDay(now).getTime() + DAY
  const followUp = facts.followUp
  if (followUp?.stage === "closed" || followUp?.stage === "dismissed") return null

  const due = followUp?.nextFollowUpAt ? new Date(followUp.nextFollowUpAt) : null
  if (due && due.getTime() < tomorrow) {
    const overdue = due.getTime() < startOfUtcDay(now).getTime()
    add("follow_up", "high", "follow_up_due", overdue ? `Follow-up overdue since ${day(due)}` : "Follow-up due today", due)
  } else if (followUp?.stage === "ready" && !due) {
    // A person judged this account worth contacting; keep it in the queue until they act.
    add("follow_up", "medium", "ready_for_outreach", `Marked ready for outreach ${day(new Date(followUp.updatedAt))}`, new Date(followUp.updatedAt))
  }

  for (const subscription of facts.subscriptions) {
    const end = subscription.currentPeriodEnd
    if (!end || end <= now) continue
    if ((subscription.status === "active" || subscription.status === "trialing") && subscription.cancelAtPeriodEnd) add("commercial", "high", "plan_ending", `Plan set to end ${day(end)}`, end)
    else if (subscription.status === "trialing" && end.getTime() - now.getTime() <= 14 * DAY) add("commercial", end.getTime() - now.getTime() <= 7 * DAY ? "high" : "medium", "trial_ending", `Trial ends ${day(end)}`, end)
  }
  if (facts.seatLimit > 1 && facts.members >= Math.ceil(facts.seatLimit * 0.8)) {
    add("commercial", facts.members >= facts.seatLimit ? "high" : "medium", "seats_near_limit", `${facts.members} of ${plural(facts.seatLimit, "seat")} in use`, facts.latestJoinAt)
  }

  const rising = facts.activeCurrent > facts.activePrevious
  if (facts.joinedThisWeek > 0) {
    add("expansion", facts.joinedThisWeek >= 2 || rising ? "high" : "medium", "members_joined", `${plural(facts.joinedThisWeek, "teammate")} joined this week`, facts.latestJoinAt)
  }
  if (rising && facts.activeCurrent >= 2) {
    add("expansion", "medium", "activity_up", `${plural(facts.activeCurrent, "observed active user")}, up from ${facts.activePrevious}`, facts.lastObservedAt)
  }
  if (facts.activePrevious >= 2 && facts.activeCurrent < facts.activePrevious) {
    const halved = facts.activePrevious >= 3 && facts.activeCurrent * 2 <= facts.activePrevious
    add("declining", halved ? "medium" : "low", "activity_down", `${plural(facts.activeCurrent, "observed active user")}, down from ${facts.activePrevious}`, facts.lastObservedAt)
  }

  const age = now.getTime() - facts.createdAt.getTime()
  if (!facts.lastObservedAt && age >= 2 * DAY && age <= 21 * DAY) {
    const priority = age <= 14 * DAY ? "medium" : "low"
    add("activation", priority, "no_observed_use", `No observed app use since the workspace was created ${day(facts.createdAt)}`, facts.createdAt)
    if (facts.skills + facts.mcpConnections > 0) {
      add("activation", priority, "setup_without_use", `${plural(facts.skills, "skill")} and ${plural(facts.mcpConnections, "connection")} set up, no observed use`, null)
    }
  }

  for (const signup of facts.signups) add("welcome", "low", "signup", `${signup.name || "A new member"} signed up ${day(signup.createdAt)}`, signup.createdAt, signup.userId)
  if (!found.length) return null

  // Being marked ready keeps an account queued; it never hides a stronger reason.
  const kinds = new Set(found.filter(entry => entry.signal.type !== "ready_for_outreach").map(entry => entry.kind))
  const kind = OPPORTUNITY_KINDS.find(value => kinds.has(value)) ?? "follow_up"
  let priority: Priority = found.reduce<Priority>((best, entry) => PRIORITY[entry.priority] > PRIORITY[best] ? entry.priority : best, "low")
  const signals = found.map(entry => entry.signal)
  let action = recommendedAction(kind, found.filter(entry => entry.kind === kind).map(entry => entry.signal), facts)
  const contacted = followUp?.lastContactedAt ? new Date(followUp.lastContactedAt) : null
  if (contacted && now.getTime() - contacted.getTime() < RECENT_CONTACT_DAYS * DAY && kind !== "follow_up") {
    signals.push({ type: "recently_contacted", label: `Contacted ${day(contacted)}`, at: contacted.toISOString(), userId: null })
    priority = "low"
    action = { label: "Wait before writing again", purpose: `Already contacted ${day(contacted)}. Record a reply, or schedule a follow-up after ${day(new Date(contacted.getTime() + RECENT_CONTACT_DAYS * DAY))}.` }
  }
  return {
    organizationId: facts.id, organizationName: facts.name, organizationCreatedAt: facts.createdAt.toISOString(),
    kind, priority, why: found.filter(entry => entry.kind === kind).map(entry => entry.signal.label).join(" · "),
    action, signals: signals.slice(0, 12), adoption: adoptionOf(facts), followUp,
  }
}

function recommendedAction(kind: Kind, signals: Signal[], facts: OrganizationFacts) {
  const types = new Set(signals.map(signal => signal.type))
  const next = facts.followUp?.nextAction
  if (kind === "follow_up" && types.has("follow_up_due")) return { label: "Follow up", purpose: next || "Complete the follow-up you scheduled." }
  if (facts.followUp?.stage === "ready" && next) return { label: next, purpose: genericAction(kind, types).purpose }
  return genericAction(kind, types)
}

function genericAction(kind: Kind, types: Set<Signal["type"]>) {
  switch (kind) {
    case "follow_up":
      if (types.has("ready_for_outreach")) return { label: "Reach out", purpose: "You marked this account ready for outreach. Record what happened once you write." }
      return { label: "Follow up", purpose: "Complete the follow-up you scheduled." }
    case "commercial":
      if (types.has("plan_ending")) return { label: "Ask what would help before the plan ends", purpose: "Learn whether something is missing; offer help, not pressure." }
      if (types.has("trial_ending")) return { label: "Offer a plan walkthrough", purpose: "Answer plan questions before the trial ends." }
      return { label: "Offer help planning seats", purpose: "The team is near its seat limit; offer to help plan for more people." }
    case "expansion": return { label: "Offer a team setup session", purpose: "Help new teammates get set up while the team is growing." }
    case "declining": return { label: "Check in and offer help", purpose: "Telemetry can be missing or turned off, so ask how things are going rather than assume." }
    case "activation": return { label: "Offer onboarding help", purpose: "Offer a short getting-started session. Do not assume a problem." }
    case "welcome": return { label: "Send a welcome note", purpose: "Introduce yourself and offer a getting-started resource." }
  }
}

export function sortOpportunities(items: OpportunityItem[]) {
  const latest = (item: OpportunityItem) => Math.max(0, ...item.signals.map(signal => signal.at ? Date.parse(signal.at) : 0))
  return items.sort((a, b) => PRIORITY[b.priority] - PRIORITY[a.priority]
    || OPPORTUNITY_KINDS.indexOf(a.kind) - OPPORTUNITY_KINDS.indexOf(b.kind)
    || latest(b) - latest(a) || a.organizationId.localeCompare(b.organizationId))
}
