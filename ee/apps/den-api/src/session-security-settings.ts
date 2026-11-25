import { DEN_SESSION_EXPIRES_IN_SECONDS } from "./session-lifetime.js"

const HOUR_SECONDS = 60 * 60

export const SESSION_LENGTH_HOURS = [12, 24, 72, 168] as const
export type SessionLengthHours = (typeof SESSION_LENGTH_HOURS)[number]
export const DEFAULT_SESSION_LENGTH_HOURS: SessionLengthHours = 168

export const MAX_SESSION_LENGTH_DAYS = [1, 7, 14, 30, 60, 90] as const
export type MaxSessionLengthDays = (typeof MAX_SESSION_LENGTH_DAYS)[number]
export const DEFAULT_MAX_SESSION_LENGTH_DAYS: MaxSessionLengthDays = 30

export const ADMIN_REAUTH_MINUTES = [15, 60, 240, 480, 1440, 0] as const
export type AdminReauthMinutes = (typeof ADMIN_REAUTH_MINUTES)[number]
export const DEFAULT_ADMIN_REAUTH_MINUTES: AdminReauthMinutes = 15

export type SessionSecuritySettings = {
  sessionLengthHours: SessionLengthHours
  maxSessionLengthDays: MaxSessionLengthDays
  adminReauthMinutes: AdminReauthMinutes
}

export type SessionLimits = {
  idleSeconds: number
  maxSeconds: number | null
}

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

export function readSessionSecuritySettings(metadata: unknown): SessionSecuritySettings {
  const parsed = parseMetadata(metadata)
  return {
    sessionLengthHours: isSessionLengthHours(parsed.sessionLengthHours) ? parsed.sessionLengthHours : DEFAULT_SESSION_LENGTH_HOURS,
    maxSessionLengthDays: isMaxSessionLengthDays(parsed.maxSessionLengthDays) ? parsed.maxSessionLengthDays : DEFAULT_MAX_SESSION_LENGTH_DAYS,
    adminReauthMinutes: isAdminReauthMinutes(parsed.adminReauthMinutes) ? parsed.adminReauthMinutes : DEFAULT_ADMIN_REAUTH_MINUTES,
  }
}

export function adminReauthMaxAgeMs(metadata: unknown): number | null {
  const minutes = readSessionSecuritySettings(metadata).adminReauthMinutes
  return minutes === 0 ? null : minutes * 60 * 1000
}

export function organizationSessionLimits(metadata: unknown): SessionLimits {
  const settings = readSessionSecuritySettings(metadata)
  return {
    idleSeconds: Math.min(DEN_SESSION_EXPIRES_IN_SECONDS, settings.sessionLengthHours * HOUR_SECONDS),
    maxSeconds: settings.maxSessionLengthDays * 24 * HOUR_SECONDS,
  }
}

export function strictestSessionLimits(limits: readonly SessionLimits[]): SessionLimits {
  let idleSeconds = DEFAULT_SESSION_LIMITS.idleSeconds
  let maxSeconds: number | null = null
  for (const entry of limits) {
    idleSeconds = Math.min(idleSeconds, entry.idleSeconds)
    if (entry.maxSeconds !== null) maxSeconds = maxSeconds === null ? entry.maxSeconds : Math.min(maxSeconds, entry.maxSeconds)
  }
  return { idleSeconds, maxSeconds }
}

export function sessionExpiresAt(input: { limits: SessionLimits; now: Date; createdAt: Date }) {
  const idle = input.now.getTime() + input.limits.idleSeconds * 1000
  if (input.limits.maxSeconds === null) return new Date(idle)
  return new Date(Math.min(idle, input.createdAt.getTime() + input.limits.maxSeconds * 1000))
}

export function sessionUpdateAgeSeconds(lifetimeSeconds: number) {
  return Math.max(60, Math.min(24 * HOUR_SECONDS, Math.floor(lifetimeSeconds / 7)))
}

export function storedSessionLifetimeSeconds(session: { expiresAt: Date; updatedAt: Date }) {
  const seconds = Math.floor((session.expiresAt.getTime() - session.updatedAt.getTime()) / 1000)
  return Math.max(0, Math.min(DEN_SESSION_EXPIRES_IN_SECONDS, seconds))
}

export function sessionRefreshDue(session: { expiresAt: Date; updatedAt: Date }, now: Date) {
  const lifetime = storedSessionLifetimeSeconds(session)
  return now.getTime() - session.updatedAt.getTime() >= sessionUpdateAgeSeconds(lifetime) * 1000
}
