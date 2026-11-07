/**
 * Pure rules for an organization's session settings (feature
 * `sessionSecuritySettings`, Auth & Security › General). No database access,
 * so they are unit tested directly (test/session-security-settings.test.ts).
 *
 * - Session length (`sessionLengthHours`): how long a sign-in lasts without
 *   activity, for every member, on the web and in the desktop app.
 * - Maximum session length (`maxSessionLengthDays`): how long a sign-in lasts
 *   at most, however active, so people sign in at least once every period.
 * A person in several organizations gets the shortest of each, because one
 * session opens all of them.
 * - Enforce fresh admin sessions (`adminReauthMinutes`): how recently the
 *   session must have been signed in before a sensitive change (the "Confirm
 *   your identity" dialog). 0 turns the check off.
 *
 * Both only apply while `sessionSecuritySettings` and `authSecuritySettings`
 * (the page they live on) are on. Otherwise sessions last 7 days and sensitive
 * changes need a sign-in from the last 2 hours, as before.
 */

import type { FeatureMap } from "@openwork/features"
import { DEN_SESSION_EXPIRES_IN_SECONDS } from "./session-lifetime.js"

const HOUR_SECONDS = 60 * 60

/** "Session length" choices, in hours. */
export const SESSION_LENGTH_HOURS = [12, 24, 72, 168] as const
export type SessionLengthHours = (typeof SESSION_LENGTH_HOURS)[number]
export const DEFAULT_SESSION_LENGTH_HOURS: SessionLengthHours = 168

/** "Maximum session length" choices, in days. */
export const MAX_SESSION_LENGTH_DAYS = [1, 7, 14, 30, 60, 90] as const
export type MaxSessionLengthDays = (typeof MAX_SESSION_LENGTH_DAYS)[number]
export const DEFAULT_MAX_SESSION_LENGTH_DAYS: MaxSessionLengthDays = 30

/** "Enforce fresh admin sessions" choices, in minutes; 0 is Disabled. */
export const ADMIN_REAUTH_MINUTES = [15, 60, 240, 480, 1440, 0] as const
export type AdminReauthMinutes = (typeof ADMIN_REAUTH_MINUTES)[number]
export const DEFAULT_ADMIN_REAUTH_MINUTES: AdminReauthMinutes = 15

/** The sign-in window for sensitive changes while the settings are off (privileged-session.ts). */
export const LEGACY_ADMIN_REAUTH_MAX_AGE_MS = 2 * 60 * 60 * 1000

export type SessionSecuritySettings = {
  sessionLengthHours: SessionLengthHours
  maxSessionLengthDays: MaxSessionLengthDays
  adminReauthMinutes: AdminReauthMinutes
}

/** How long a session may last: without activity, and at most from sign-in (null: no limit). In seconds. */
export type SessionLimits = {
  idleSeconds: number
  maxSeconds: number | null
}

/** Today's sessions: 7 days without activity, renewed for as long as they are used. */
export const DEFAULT_SESSION_LIMITS: SessionLimits = { idleSeconds: DEN_SESSION_EXPIRES_IN_SECONDS, maxSeconds: null }

export function isSessionLengthHours(value: unknown): value is SessionLengthHours {
  return SESSION_LENGTH_HOURS.some((hours) => hours === value)
}

export function isMaxSessionLengthDays(value: unknown): value is MaxSessionLengthDays {
  return MAX_SESSION_LENGTH_DAYS.some((days) => days === value)
}

export function isAdminReauthMinutes(value: unknown): value is AdminReauthMinutes {
  return ADMIN_REAUTH_MINUTES.some((minutes) => minutes === value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseMetadata(metadata: unknown): Record<string, unknown> {
  if (isRecord(metadata)) return metadata
  if (typeof metadata !== "string" || !metadata.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(metadata)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** The organization's saved choices, with the defaults for anything unset. */
export function readSessionSecuritySettings(metadata: unknown): SessionSecuritySettings {
  const parsed = parseMetadata(metadata)
  return {
    sessionLengthHours: isSessionLengthHours(parsed.sessionLengthHours) ? parsed.sessionLengthHours : DEFAULT_SESSION_LENGTH_HOURS,
    maxSessionLengthDays: isMaxSessionLengthDays(parsed.maxSessionLengthDays) ? parsed.maxSessionLengthDays : DEFAULT_MAX_SESSION_LENGTH_DAYS,
    adminReauthMinutes: isAdminReauthMinutes(parsed.adminReauthMinutes) ? parsed.adminReauthMinutes : DEFAULT_ADMIN_REAUTH_MINUTES,
  }
}

/** Whether the organization's settings apply: the feature and the Auth & Security page that shows them. */
export function sessionSecuritySettingsApply(features: Pick<FeatureMap, "sessionSecuritySettings" | "authSecuritySettings">) {
  return features.sessionSecuritySettings && features.authSecuritySettings
}

/**
 * How recent a sign-in must be for a sensitive change, in milliseconds, or
 * null when the organization turned the check off.
 */
export function adminReauthMaxAgeMs(input: { features: Pick<FeatureMap, "sessionSecuritySettings" | "authSecuritySettings">; metadata: unknown }): number | null {
  if (!sessionSecuritySettingsApply(input.features)) return LEGACY_ADMIN_REAUTH_MAX_AGE_MS
  const minutes = readSessionSecuritySettings(input.metadata).adminReauthMinutes
  return minutes === 0 ? null : minutes * 60 * 1000
}

/** One organization's session limits; today's (7 days, no maximum) while its settings do not apply. */
export function organizationSessionLimits(input: { features: Pick<FeatureMap, "sessionSecuritySettings" | "authSecuritySettings">; metadata: unknown }): SessionLimits {
  if (!sessionSecuritySettingsApply(input.features)) return DEFAULT_SESSION_LIMITS
  const settings = readSessionSecuritySettings(input.metadata)
  return {
    idleSeconds: Math.min(DEN_SESSION_EXPIRES_IN_SECONDS, settings.sessionLengthHours * HOUR_SECONDS),
    maxSeconds: settings.maxSessionLengthDays * 24 * HOUR_SECONDS,
  }
}

/** The strictest of several organizations' limits (one session opens all of them). */
export function strictestSessionLimits(limits: readonly SessionLimits[]): SessionLimits {
  let idleSeconds = DEFAULT_SESSION_LIMITS.idleSeconds
  let maxSeconds: number | null = null
  for (const entry of limits) {
    idleSeconds = Math.min(idleSeconds, entry.idleSeconds)
    if (entry.maxSeconds !== null) maxSeconds = maxSeconds === null ? entry.maxSeconds : Math.min(maxSeconds, entry.maxSeconds)
  }
  return { idleSeconds, maxSeconds }
}

/**
 * When a session used now expires: its length without activity from now,
 * but never past its maximum length from sign-in (`createdAt`).
 */
export function sessionExpiresAt(input: { limits: SessionLimits; now: Date; createdAt: Date }) {
  const idle = input.now.getTime() + input.limits.idleSeconds * 1000
  if (input.limits.maxSeconds === null) return new Date(idle)
  return new Date(Math.min(idle, input.createdAt.getTime() + input.limits.maxSeconds * 1000))
}

/**
 * How often an active session is extended, in seconds: once a day for the
 * 7-day default, as before, and proportionally more often for shorter ones
 * so a 12-hour session is not closed while someone is using it.
 */
export function sessionUpdateAgeSeconds(lifetimeSeconds: number) {
  return Math.max(60, Math.min(24 * HOUR_SECONDS, Math.floor(lifetimeSeconds / 7)))
}

/**
 * The session's lifetime as last set: the time from its last extension
 * (`updatedAt`) to its expiry, never more than 7 days. Read from the row so
 * the hot path needs no organization lookup to know whether it is due.
 */
export function storedSessionLifetimeSeconds(session: { expiresAt: Date; updatedAt: Date }) {
  const seconds = Math.floor((session.expiresAt.getTime() - session.updatedAt.getTime()) / 1000)
  return Math.max(0, Math.min(DEN_SESSION_EXPIRES_IN_SECONDS, seconds))
}

/** Whether an active session is due to be extended (and its length re-read). */
export function sessionRefreshDue(session: { expiresAt: Date; updatedAt: Date }, now: Date) {
  const lifetime = storedSessionLifetimeSeconds(session)
  return now.getTime() - session.updatedAt.getTime() >= sessionUpdateAgeSeconds(lifetime) * 1000
}
