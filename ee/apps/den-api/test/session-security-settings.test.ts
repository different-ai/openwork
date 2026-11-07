import assert from "node:assert/strict"
import { test } from "node:test"
import { checkFreshPrivilegedSession } from "../src/privileged-session.js"
import {
  adminReauthMaxAgeMs,
  organizationSessionLimits,
  readSessionSecuritySettings,
  sessionRefreshDue,
  sessionSecuritySettingsApply,
  sessionExpiresAt,
  sessionUpdateAgeSeconds,
  strictestSessionLimits,
} from "../src/session-security-settings.js"

const on = { sessionSecuritySettings: true, authSecuritySettings: true }
const off = { sessionSecuritySettings: false, authSecuritySettings: true }
const pageOff = { sessionSecuritySettings: true, authSecuritySettings: false }
const HOUR = 60 * 60
const DAY = 24 * HOUR

test("the settings apply only with the feature and the Auth & Security page on", () => {
  assert.equal(sessionSecuritySettingsApply(on), true)
  assert.equal(sessionSecuritySettingsApply(off), false)
  assert.equal(sessionSecuritySettingsApply(pageOff), false)
})

test("unset or unknown choices read as the defaults: 7 days, at most 30 days, and 15 minutes", () => {
  const defaults = { sessionLengthHours: 168, maxSessionLengthDays: 30, adminReauthMinutes: 15 }
  assert.deepEqual(readSessionSecuritySettings(null), defaults)
  assert.deepEqual(readSessionSecuritySettings(JSON.stringify({ sessionLengthHours: 5, maxSessionLengthDays: 365, adminReauthMinutes: 7 })), defaults)
  assert.deepEqual(readSessionSecuritySettings({ sessionLengthHours: 12, maxSessionLengthDays: 90, adminReauthMinutes: 0 }), { sessionLengthHours: 12, maxSessionLengthDays: 90, adminReauthMinutes: 0 })
})

test("admin re-authentication: the organization's window, off at 0, 2 hours while the settings do not apply", () => {
  assert.equal(adminReauthMaxAgeMs({ features: on, metadata: null }), 15 * 60 * 1000)
  assert.equal(adminReauthMaxAgeMs({ features: on, metadata: { adminReauthMinutes: 480 } }), 8 * HOUR * 1000)
  assert.equal(adminReauthMaxAgeMs({ features: on, metadata: { adminReauthMinutes: 0 } }), null)
  assert.equal(adminReauthMaxAgeMs({ features: off, metadata: { adminReauthMinutes: 0 } }), 2 * HOUR * 1000)
  assert.equal(adminReauthMaxAgeMs({ features: pageOff, metadata: { adminReauthMinutes: 0 } }), 2 * HOUR * 1000)
})

test("a session signed in 20 minutes ago passes a 1 hour window, fails 15 minutes, and always passes when off", () => {
  const session = { createdAt: new Date(Date.now() - 20 * 60 * 1000) }
  assert.equal(checkFreshPrivilegedSession({ apiKey: null, session }, 60 * 60 * 1000).ok, true)
  assert.equal(checkFreshPrivilegedSession({ apiKey: null, session }, 15 * 60 * 1000).ok, false)
  assert.equal(checkFreshPrivilegedSession({ apiKey: null, session }, null).ok, true)
})

test("session limits: the organization's choices; 7 days and no maximum while the settings do not apply", () => {
  assert.deepEqual(organizationSessionLimits({ features: on, metadata: { sessionLengthHours: 12, maxSessionLengthDays: 7 } }), { idleSeconds: 12 * HOUR, maxSeconds: 7 * DAY })
  assert.deepEqual(organizationSessionLimits({ features: on, metadata: null }), { idleSeconds: 7 * DAY, maxSeconds: 30 * DAY })
  assert.deepEqual(organizationSessionLimits({ features: off, metadata: { sessionLengthHours: 12 } }), { idleSeconds: 7 * DAY, maxSeconds: null })
})

test("a person in several organizations gets the strictest of each limit", () => {
  assert.deepEqual(strictestSessionLimits([]), { idleSeconds: 7 * DAY, maxSeconds: null })
  assert.deepEqual(strictestSessionLimits([
    { idleSeconds: 12 * HOUR, maxSeconds: 90 * DAY },
    { idleSeconds: 7 * DAY, maxSeconds: null },
    { idleSeconds: 3 * DAY, maxSeconds: 14 * DAY },
  ]), { idleSeconds: 12 * HOUR, maxSeconds: 14 * DAY })
})

test("an active session is extended by its length, but never past its maximum from sign-in", () => {
  const createdAt = new Date("2026-11-01T00:00:00Z")
  const limits = { idleSeconds: 7 * DAY, maxSeconds: 30 * DAY }
  assert.equal(sessionExpiresAt({ limits, createdAt, now: new Date("2026-11-02T00:00:00Z") }).toISOString(), "2026-11-09T00:00:00.000Z")
  assert.equal(sessionExpiresAt({ limits, createdAt, now: new Date("2026-11-28T00:00:00Z") }).toISOString(), "2026-12-01T00:00:00.000Z")
  assert.equal(sessionExpiresAt({ limits: { ...limits, maxSeconds: null }, createdAt, now: new Date("2026-11-28T00:00:00Z") }).toISOString(), "2026-12-05T00:00:00.000Z")
})

test("active sessions are extended once a day at 7 days, and more often when shorter", () => {
  assert.equal(sessionUpdateAgeSeconds(7 * DAY), DAY)
  assert.ok(sessionUpdateAgeSeconds(12 * HOUR) < 2 * HOUR)
  const now = new Date("2026-11-06T12:00:00Z")
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000)
  const after = (from: Date, seconds: number) => new Date(from.getTime() + seconds * 1000)
  // 7-day session extended 23 hours ago: not due; 25 hours ago: due (unchanged from before).
  assert.equal(sessionRefreshDue({ updatedAt: ago(23 * HOUR), expiresAt: after(ago(23 * HOUR), 7 * DAY) }, now), false)
  assert.equal(sessionRefreshDue({ updatedAt: ago(25 * HOUR), expiresAt: after(ago(25 * HOUR), 7 * DAY) }, now), true)
  // 12-hour session extended 2 hours ago: due.
  assert.equal(sessionRefreshDue({ updatedAt: ago(2 * HOUR), expiresAt: after(ago(2 * HOUR), 12 * HOUR) }, now), true)
})
