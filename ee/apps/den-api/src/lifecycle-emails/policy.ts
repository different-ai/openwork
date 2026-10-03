import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Pure rules for lifecycle reminder emails. No env, database or network
 * access, so the windows and the unsubscribe token can be unit-tested.
 */

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export const LIFECYCLE_EMAIL_KINDS = {
  claimReminder: "claim_reminder",
  teamNudge: "team_nudge",
  unsubscribe: "unsubscribe",
} as const

/** Remind once the person has had most of a day, while there is still time to act. */
export const CLAIM_REMINDER_MIN_AGE_MS = 20 * HOUR_MS
export const CLAIM_REMINDER_MIN_REMAINING_MS = 3 * HOUR_MS

/** Nudge a solo owner after they have had a couple of days alone, never for stale orgs. */
export const TEAM_NUDGE_MIN_AGE_MS = 2 * DAY_MS
export const TEAM_NUDGE_MAX_AGE_MS = 14 * DAY_MS

export function isClaimReminderDue(input: { createdAt: Date; expiresAt: Date; now: Date }): boolean {
  const age = input.now.getTime() - input.createdAt.getTime()
  const remaining = input.expiresAt.getTime() - input.now.getTime()
  return age >= CLAIM_REMINDER_MIN_AGE_MS && remaining >= CLAIM_REMINDER_MIN_REMAINING_MS
}

export function isTeamNudgeDue(input: {
  organizationCreatedAt: Date
  now: Date
  activeMemberCount: number
  invitationCount: number
}): boolean {
  const age = input.now.getTime() - input.organizationCreatedAt.getTime()
  return (
    age >= TEAM_NUDGE_MIN_AGE_MS
    && age <= TEAM_NUDGE_MAX_AGE_MS
    && input.activeMemberCount === 1
    && input.invitationCount === 0
  )
}

export function normalizeEmailAddress(email: string): string {
  return email.trim().toLowerCase()
}

function unsubscribeMac(email: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`openwork-lifecycle-unsubscribe:${normalizeEmailAddress(email)}`).digest()
}

/** Stateless unsubscribe token: an HMAC of the address, so links never expire. */
export function signUnsubscribeToken(email: string, secret: string): string {
  return unsubscribeMac(email, secret).toString("base64url")
}

export function verifyUnsubscribeToken(email: string, token: string, secret: string): boolean {
  const expected = unsubscribeMac(email, secret)
  let provided: Buffer
  try {
    provided = Buffer.from(token, "base64url")
  } catch {
    return false
  }
  return provided.length === expected.length && timingSafeEqual(new Uint8Array(provided), new Uint8Array(expected))
}

/** "Monday, October 6 at 3:00 PM UTC" */
export function formatExpiryLabel(date: Date): string {
  const day = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }).format(date)
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(date)
  return `${day} at ${time} UTC`
}
