import type { ConnectorCheck } from "@openwork/types/den/diagnostics"
import type { GoogleApiCheck } from "../routes/org/google-api-check.js"
import { SlackApiError } from "../slack-assistant/protocol.js"

/** Pure connector state mapping for Settings › Diagnostics. */

export type SlackLiveResult = "accepted" | "rejected" | "unavailable"

/** Slack errors that mean the stored bot token no longer works for this workspace. */
const SLACK_REJECTED_CODES = new Set([
  "invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired",
  "no_permission", "org_login_required", "team_access_not_granted", "missing_scope",
])

/** auth.test must succeed for the installed workspace; transient failures stay unchecked. */
export function classifySlackAuthTest(outcome: { ok: true; teamId: unknown } | { ok: false; error: unknown }, installedTeamId: string | null): SlackLiveResult {
  if (outcome.ok) return installedTeamId !== null && outcome.teamId === installedTeamId ? "accepted" : "rejected"
  if (outcome.error instanceof SlackApiError && SLACK_REJECTED_CODES.has(outcome.error.code)) return "rejected"
  return "unavailable"
}

export type SlackConnectorInput = {
  id: string
  name: string
  runnerAvailable: boolean
  enabled: boolean
  hasBotToken: boolean
  lastEventAt: Date | null
  completed24h: number | null
  live: { result: SlackLiveResult; checkedAt: string } | null
}

/** Whether a Slack row's state depends on a live token check. */
export function slackNeedsLiveCheck(input: Pick<SlackConnectorInput, "runnerAvailable" | "enabled" | "hasBotToken">): boolean {
  return input.enabled && input.runnerAvailable && input.hasBotToken
}

export function slackConnectorCheck(input: SlackConnectorInput): ConnectorCheck {
  const base = {
    id: input.id, kind: "slack_assistant" as const, name: input.name, apis: [],
    lastEventAt: input.lastEventAt ? input.lastEventAt.toISOString() : null,
    completed24h: input.completed24h,
  }
  if (!input.enabled) return { ...base, state: "off", reason: "slack_assistant_off", checkedAt: null }
  if (!input.runnerAvailable) return { ...base, state: "off", reason: "slack_runner_missing", checkedAt: null }
  if (!input.hasBotToken) return { ...base, state: "attention", reason: "slack_not_installed", checkedAt: null }
  if (!input.live || input.live.result === "unavailable") {
    return { ...base, state: "not_checked", reason: "not_checked_yet", checkedAt: input.live?.checkedAt ?? null }
  }
  return input.live.result === "accepted"
    ? { ...base, state: "ready", reason: "slack_token_accepted", checkedAt: input.live.checkedAt }
    : { ...base, state: "attention", reason: "slack_token_rejected", checkedAt: input.live.checkedAt }
}

export type GoogleConnectorInput = {
  id: string
  name: string
  /** APIs the connector's enabled permissions call. */
  apis: ReadonlyArray<{ id: string; name: string }>
  /** The caller's own check: null checks = the caller has no sign-in on this connector. */
  live: { checks: readonly Pick<GoogleApiCheck, "id" | "name" | "status">[] | null; checkedAt: string } | null
}

export function googleConnectorCheck(input: GoogleConnectorInput): ConnectorCheck {
  const base = { id: input.id, kind: "google_workspace" as const, name: input.name, lastEventAt: null, completed24h: null }
  const unknown = input.apis.slice(0, 12).map((api) => ({ id: api.id, name: api.name, status: "unknown" as const }))
  if (!input.live) return { ...base, state: "not_checked", reason: "not_checked_yet", checkedAt: null, apis: unknown }
  if (!input.live.checks) return { ...base, state: "not_checked", reason: "google_sign_in_required", checkedAt: input.live.checkedAt, apis: unknown }
  const apis = input.live.checks.slice(0, 12).map((api) => ({ id: api.id, name: api.name, status: api.status }))
  if (apis.some((api) => api.status === "disabled")) {
    return { ...base, state: "attention", reason: "google_api_disabled", checkedAt: input.live.checkedAt, apis }
  }
  if (apis.every((api) => api.status === "enabled")) {
    return { ...base, state: "ready", reason: "google_apis_enabled", checkedAt: input.live.checkedAt, apis }
  }
  // Some APIs could not be checked: the caller's sign-in lacks that permission, or Google was unreachable.
  return { ...base, state: "not_checked", reason: "google_sign_in_required", checkedAt: input.live.checkedAt, apis }
}
