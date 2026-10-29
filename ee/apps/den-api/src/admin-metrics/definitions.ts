/**
 * Pure metric definitions shared by the admin Control Center snapshots and the
 * den-admin MCP tools. Everything here works on plain values so the rules can
 * be unit-tested without a database. Days are UTC dates (YYYY-MM-DD) and weeks
 * start on Monday, named by that Monday's date.
 */

export const DAY_MS = 86_400_000

export function dayKey(time: Date | number): string {
  return new Date(time).toISOString().slice(0, 10)
}

export function dayTime(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`)
}

export function addDays(day: string, days: number): string {
  return dayKey(dayTime(day) + days * DAY_MS)
}

/** The Monday that starts the week containing `day`. */
export function weekStart(day: string): string {
  const offset = (new Date(dayTime(day)).getUTCDay() + 6) % 7
  return addDays(day, -offset)
}

/** `count` consecutive week starts ending with the week that contains `lastDay`. */
export function weekStarts(lastDay: string, count: number): string[] {
  const last = weekStart(lastDay)
  return Array.from({ length: count }, (_, index) => addDays(last, (index - count + 1) * 7))
}

/** A share, or null when there is nothing to divide by. */
export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle] ?? 0
  return sorted.length % 2 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2
}

/** Coerce a driver value (string, bigint, number, null) to a finite number. */
export function num(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/** A driver date or datetime value as a UTC day key, or null. */
export function toDay(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : dayKey(value)
  if (typeof value === "string" && value.trim()) {
    const text = value.trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
    const time = Date.parse(text.includes("T") || text.endsWith("Z") ? text : `${text.replace(" ", "T")}Z`)
    return Number.isNaN(time) ? null : dayKey(time)
  }
  return null
}

/** One person's task activity: the UTC day they signed up and the UTC days they ran a task. */
export type UserActivity = { signupDay: string; days: ReadonlySet<string> }

export type LifecycleWeek = { week: string; new: number; stillActive: number; returned: number; lost: number; gainsVsLosses: number | null }

/**
 * Weekly growth accounting. Everyone active in a week is exactly one of: new
 * (signed up that week), still active (also active the week before) or back
 * after a skipped week (signed up earlier, not active the week before). Lost
 * people were active the week before and not this week.
 */
export function classifyWeeks(users: Iterable<UserActivity>, weeks: readonly string[]): LifecycleWeek[] {
  const rows = weeks.map((week) => ({ week, new: 0, stillActive: 0, returned: 0, lost: 0 }))
  for (const user of users) {
    const activeWeeks = new Set([...user.days].map(weekStart))
    const signupWeek = weekStart(user.signupDay)
    for (const row of rows) {
      const current = activeWeeks.has(row.week)
      const previous = activeWeeks.has(addDays(row.week, -7))
      if (current) {
        if (signupWeek === row.week) row.new += 1
        else if (previous) row.stillActive += 1
        else row.returned += 1
      } else if (previous) {
        row.lost += 1
      }
    }
  }
  return rows.map((row) => ({ ...row, gainsVsLosses: ratio(row.new + row.returned, row.lost) }))
}

export const REACTIVATION_QUIET_DAYS = 14

/**
 * Reactivated in a week: active that week, no activity in the 14 days before
 * it, and an account at least 14 days old when the week started.
 */
export function isReactivated(user: UserActivity, week: string): boolean {
  const end = addDays(week, 7)
  const quietFrom = addDays(week, -REACTIVATION_QUIET_DAYS)
  if (user.signupDay > quietFrom) return false
  let activeInWeek = false
  for (const day of user.days) {
    if (day >= quietFrom && day < week) return false
    if (day >= week && day < end) activeInWeek = true
  }
  return activeInWeek
}

export function activeBetween(user: UserActivity, from: string, to: string): boolean {
  for (const day of user.days) if (day >= from && day < to) return true
  return false
}

export type ActivationFunnel = { signedUp: number; ranTaskWithin3Days: number; backAfterDay1: number; activeInWeek1: number }

/**
 * Activation of people who signed up in [from, to]: ran a task within 3 days
 * of signing up, then came back on a later day in their first week, then were
 * active again in the week after (days 7–13). Each step is a subset of the
 * one before. Callers pick `to` at least 14 days ago so every step can happen.
 */
export function activationFunnel(users: Iterable<UserActivity>, from: string, to: string): ActivationFunnel {
  const funnel = { signedUp: 0, ranTaskWithin3Days: 0, backAfterDay1: 0, activeInWeek1: 0 }
  for (const user of users) {
    if (user.signupDay < from || user.signupDay > to) continue
    funnel.signedUp += 1
    const signup = user.signupDay
    if (!activeBetween(user, signup, addDays(signup, 3))) continue
    funnel.ranTaskWithin3Days += 1
    if (!activeBetween(user, addDays(signup, 1), addDays(signup, 7))) continue
    funnel.backAfterDay1 += 1
    if (activeBetween(user, addDays(signup, 7), addDays(signup, 14))) funnel.activeInWeek1 += 1
  }
  return funnel
}

export type RetentionCohort = { cohort: string; signups: number; retained: Map<number, number> }

/**
 * Weekly signup cohorts: for each signup cohort, how many people were active
 * N whole weeks after signing up (week 0 is the first 7 days). Shared by the
 * den_retention MCP tool and the Control Center heatmap; callers choose the
 * cohort label and which activity counts.
 */
export function buildRetentionCohorts(
  signups: Iterable<{ userId: string; cohort: string; signupTime: number }>,
  activity: Iterable<{ userId: string; dayTime: number }>,
): RetentionCohort[] {
  const signupByUser = new Map<string, { cohort: string; signupTime: number }>()
  const cohorts = new Map<string, { size: number; retained: Map<number, Set<string>> }>()
  for (const signup of signups) {
    signupByUser.set(signup.userId, signup)
    const cohort = cohorts.get(signup.cohort) ?? { size: 0, retained: new Map() }
    cohort.size += 1
    cohorts.set(signup.cohort, cohort)
  }
  for (const row of activity) {
    const signup = signupByUser.get(row.userId)
    if (!signup) continue
    const offset = Math.floor((row.dayTime - signup.signupTime) / (7 * DAY_MS))
    if (offset < 0) continue
    const cohort = cohorts.get(signup.cohort)
    if (!cohort) continue
    const users = cohort.retained.get(offset) ?? new Set<string>()
    users.add(row.userId)
    cohort.retained.set(offset, users)
  }
  return [...cohorts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohort, value]) => ({
      cohort,
      signups: value.size,
      retained: new Map([...value.retained.entries()].sort((a, b) => a[0] - b[0]).map(([offset, users]) => [offset, users.size])),
    }))
}

/** A skill or connection use, already scoped to team organizations by the caller. */
export type CapabilityUse = { memberId: string; creatorId: string | null; uses: number }

/** Share of uses made by someone other than the skill or connection's creator. */
export function reuseRate(uses: Iterable<CapabilityUse>): { total: number; byOthers: number; rate: number | null } {
  let total = 0
  let byOthers = 0
  for (const use of uses) {
    total += use.uses
    if (use.creatorId !== null && use.creatorId !== use.memberId) byOthers += use.uses
  }
  return { total, byOthers, rate: ratio(byOthers, total) }
}

export type SkillGrant = { orgWide: boolean; teamId: string | null; memberId: string | null }

/** Shared means granted to the whole organization, a team, or another person. */
export function isSharedSkill(creatorId: string, grants: readonly SkillGrant[]): boolean {
  return grants.some((grant) => grant.orgWide || grant.teamId !== null || (grant.memberId !== null && grant.memberId !== creatorId))
}

/** Failure and abandonment rates from task lifecycle event counts. */
export function taskOutcomes(started: number, completed: number, failed: number) {
  const abandoned = Math.max(0, started - completed - failed)
  return { started, completed, failed, abandoned, failureRate: ratio(failed, started), abandonedRate: ratio(abandoned, started) }
}

/** Monday–Friday days in [from, to). */
export function weekdaysBetween(from: string, to: string): number {
  let weekdays = 0
  for (let day = from; day < to; day = addDays(day, 1)) {
    const dow = new Date(dayTime(day)).getUTCDay()
    if (dow !== 0 && dow !== 6) weekdays += 1
  }
  return weekdays
}
