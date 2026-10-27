import assert from "node:assert/strict"
import { test } from "node:test"
import { desktopDiagnosticsSchema, desktopStartupReportSchema, orgDiagnosticsSchema, type OrgDiagnostics, type ProviderCheck } from "@openwork/types/den/diagnostics"
import { SlackApiError } from "../src/slack-assistant/protocol.js"
import { deriveDiagnosticsAttention, hasDiagnosticsErrors } from "../src/diagnostics/attention.js"
import { classifySlackAuthTest, googleConnectorCheck, slackConnectorCheck } from "../src/diagnostics/connector-checks.js"
import {
  desktopStartupObservedAtAccepted,
  desktopStartupStepDurations,
  percentile,
  summarizeDesktopStartups,
  type DesktopStartupRow,
} from "../src/diagnostics/desktop-startup-summary.js"

const NOW = Date.parse("2026-10-20T12:00:00.000Z")
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000)

function launch(input: Partial<DesktopStartupRow>): DesktopStartupRow {
  return {
    orgMembershipId: "om_a", appVersion: "0.20.0", success: true, failedStep: null, failureReason: null,
    windowMs: 400, engineMs: 1_400, signedInMs: 1_900, orgToolsMs: 2_500, observedAt: minutesAgo(5), ...input,
  }
}

test("percentiles use nearest rank over whole milliseconds", () => {
  assert.equal(percentile([], 0.5), null)
  assert.equal(percentile([7], 0.95), 7)
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2)
  assert.equal(percentile(Array.from({ length: 100 }, (_, index) => index + 1), 0.95), 95)
  assert.equal(percentile([1.4, 1.6], 0.95), 2)
})

test("step durations follow window → engine → signed_in → org_tools from the previous reached step, never negative", () => {
  assert.deepEqual(desktopStartupStepDurations(launch({})), { window: 400, engine: 1_000, signed_in: 500, org_tools: 600 })
  // The engine finished before the window: overlap clamps to zero; the next step measures from the engine.
  assert.deepEqual(desktopStartupStepDurations(launch({ windowMs: 900, engineMs: 600, signedInMs: 1_000, orgToolsMs: 1_200 })), { window: 900, engine: 0, signed_in: 400, org_tools: 200 })
  assert.deepEqual(desktopStartupStepDurations(launch({ signedInMs: null })), { window: 400, engine: 1_000, signed_in: null, org_tools: 1_100 })
})

test("desktop summary: counts, people, percentiles of successful launches, failures and versions", () => {
  const rows: DesktopStartupRow[] = [
    launch({ orgMembershipId: "om_a", orgToolsMs: 2_000 }),
    launch({ orgMembershipId: "om_a", orgToolsMs: 3_000, appVersion: "0.21.0" }),
    launch({ orgMembershipId: "om_b", orgToolsMs: 9_000 }),
    launch({ orgMembershipId: "om_b", success: false, failedStep: "signed_in", failureReason: "certificate", orgToolsMs: null, signedInMs: null, observedAt: minutesAgo(30) }),
    launch({ orgMembershipId: "om_c", success: false, failedStep: "signed_in", failureReason: "certificate", orgToolsMs: null, signedInMs: null, observedAt: minutesAgo(10) }),
    launch({ orgMembershipId: "om_c", success: false, failedStep: "engine", failureReason: "engine_failed", engineMs: null, signedInMs: null, orgToolsMs: null }),
    // Outside the window, and a corrupt stored code: ignored.
    launch({ orgMembershipId: "om_d", observedAt: minutesAgo(25 * 60) }),
    launch({ orgMembershipId: "om_e", success: false, failedStep: "window", failureReason: "not-a-reason", observedAt: minutesAgo(1) }),
  ]
  const summary = desktopDiagnosticsSchema.parse(summarizeDesktopStartups(rows, NOW))
  assert.equal(summary.startups, 7)
  assert.equal(summary.connected, 3)
  assert.equal(summary.failed, 4)
  assert.equal(summary.people, 4)
  assert.equal(summary.typicalMs, 3_000)
  assert.equal(summary.slowestMs, 9_000)
  assert.deepEqual(summary.steps, [
    { step: "window", typicalMs: 400 },
    { step: "engine", typicalMs: 1_000 },
    { step: "signed_in", typicalMs: 500 },
    { step: "org_tools", typicalMs: 1_100 },
  ])
  assert.deepEqual(summary.failures, [
    { step: "signed_in", reason: "certificate", count: 2, people: 2, lastSeenAt: minutesAgo(10).toISOString() },
    { step: "engine", reason: "engine_failed", count: 1, people: 1, lastSeenAt: minutesAgo(5).toISOString() },
  ])
  assert.deepEqual(summary.versions, [{ version: "0.20.0", startups: 6 }, { version: "0.21.0", startups: 1 }])
  const empty = summarizeDesktopStartups([], NOW)
  assert.deepEqual([empty.startups, empty.typicalMs, empty.failures.length, empty.steps.length], [0, null, 0, 4])
})

test("ingest validation: one launch per attempt, fixed codes, and a bounded time window", () => {
  const valid = {
    attemptId: "4b0f7f86-0c39-4c8f-9f53-4a51b1d4a001", appVersion: "0.20.0", platform: "darwin", observedAt: new Date(NOW).toISOString(),
    success: false, steps: { window: 300, engine: null, signed_in: null, org_tools: null }, failedStep: "engine", reason: "engine_failed",
  }
  assert.equal(desktopStartupReportSchema.safeParse(valid).success, true)
  assert.equal(desktopStartupReportSchema.safeParse({ ...valid, reason: null }).success, false, "a failed launch names its reason")
  assert.equal(desktopStartupReportSchema.safeParse({ ...valid, success: true }).success, false, "a successful launch has no failure")
  assert.equal(desktopStartupReportSchema.safeParse({ ...valid, hostname: "laptop.example" }).success, false, "no extra fields")
  assert.equal(desktopStartupReportSchema.safeParse({ ...valid, reason: "ECONNREFUSED 10.0.0.5:443" }).success, false, "fixed codes, never error text")
  assert.equal(desktopStartupReportSchema.safeParse({ ...valid, appVersion: "../../etc" }).success, false)
  assert.equal(desktopStartupObservedAtAccepted(new Date(NOW - 6 * 86_400_000), NOW), true)
  assert.equal(desktopStartupObservedAtAccepted(new Date(NOW - 8 * 86_400_000), NOW), false)
  assert.equal(desktopStartupObservedAtAccepted(new Date(NOW + 4 * 60_000), NOW), true)
  assert.equal(desktopStartupObservedAtAccepted(new Date(NOW + 6 * 60_000), NOW), false)
})

test("Slack and Google connector states", () => {
  assert.equal(classifySlackAuthTest({ ok: true, teamId: "T1" }, "T1"), "accepted")
  assert.equal(classifySlackAuthTest({ ok: true, teamId: "T2" }, "T1"), "rejected", "a token for another workspace is rejected")
  assert.equal(classifySlackAuthTest({ ok: false, error: new SlackApiError("invalid_auth") }, "T1"), "rejected")
  assert.equal(classifySlackAuthTest({ ok: false, error: new SlackApiError("ratelimited") }, "T1"), "unavailable")
  assert.equal(classifySlackAuthTest({ ok: false, error: new TypeError("fetch failed") }, "T1"), "unavailable")
  const slack = { id: "slack:emc_1", name: "Slack", runnerAvailable: true, enabled: true, hasBotToken: true, lastEventAt: null, completed24h: 3, live: null }
  const at = new Date(NOW).toISOString()
  assert.equal(slackConnectorCheck({ ...slack, enabled: false }).reason, "slack_assistant_off")
  assert.equal(slackConnectorCheck({ ...slack, runnerAvailable: false }).reason, "slack_runner_missing")
  assert.equal(slackConnectorCheck({ ...slack, hasBotToken: false }).state, "attention")
  assert.equal(slackConnectorCheck(slack).reason, "not_checked_yet")
  assert.equal(slackConnectorCheck({ ...slack, live: { result: "accepted", checkedAt: at } }).state, "ready")
  assert.equal(slackConnectorCheck({ ...slack, live: { result: "rejected", checkedAt: at } }).reason, "slack_token_rejected")

  const apis = [{ id: "drive", name: "Google Drive API" }, { id: "gmail", name: "Gmail API" }]
  const google = { id: "google:emc_2", name: "Google Workspace", apis }
  assert.deepEqual(googleConnectorCheck({ ...google, live: null }).apis.map((api) => api.status), ["unknown", "unknown"])
  assert.equal(googleConnectorCheck({ ...google, live: { checks: null, checkedAt: at } }).reason, "google_sign_in_required")
  const disabled = googleConnectorCheck({ ...google, live: { checks: [{ ...apis[0], status: "enabled" }, { ...apis[1], status: "disabled" }], checkedAt: at } })
  assert.deepEqual([disabled.state, disabled.reason], ["attention", "google_api_disabled"])
  assert.equal(googleConnectorCheck({ ...google, live: { checks: apis.map((api) => ({ ...api, status: "enabled" as const })), checkedAt: at } }).state, "ready")
})

function providerRow(input: Partial<ProviderCheck>): ProviderCheck {
  return {
    id: "ipr_x:gcs_x", source: "gateway", providerId: "openai", name: "OpenAI", credentialName: null, state: "ready", reason: "models_listed",
    httpStatus: 200, durationMs: 10, checkedAt: null, lastSuccessAt: null, models: { configured: 1, served: 1, missing: [] }, members: null, ...input,
  }
}

test("attention is derived only from visible sections, errors first", () => {
  const desktop = summarizeDesktopStartups([
    launch({ success: false, failedStep: "signed_in", failureReason: "certificate", signedInMs: null, orgToolsMs: null }),
    launch({ success: false, failedStep: "signed_in", failureReason: "certificate", signedInMs: null, orgToolsMs: null }),
    launch({ success: false, failedStep: "engine", failureReason: "engine_failed", engineMs: null, signedInMs: null, orgToolsMs: null }),
  ], NOW)
  const sections: Pick<OrgDiagnostics, "desktop" | "providers" | "connectors" | "installation"> = {
    desktop,
    providers: {
      access: "granted", checkedAt: null, checking: false, items: [
        providerRow({ id: "a", name: "Missing models", state: "model_missing", models: { configured: 3, served: 1, missing: ["m1", "m2"] } }),
        providerRow({ id: "b", name: "Rejected", state: "key_rejected", reason: "credential_rejected" }),
        providerRow({ id: "c", name: "Down", state: "unreachable", reason: "timeout" }),
        providerRow({ id: "d", name: "Broken", state: "misconfigured", reason: "configuration_error" }),
        providerRow({ id: "e", name: "Fine" }),
      ],
    },
    connectors: {
      access: "granted", checkedAt: null, items: [
        slackConnectorCheck({ id: "slack:1", name: "Slack", runnerAvailable: true, enabled: true, hasBotToken: true, lastEventAt: null, completed24h: null, live: { result: "rejected", checkedAt: new Date(NOW).toISOString() } }),
        slackConnectorCheck({ id: "slack:2", name: "Slack 2", runnerAvailable: true, enabled: true, hasBotToken: false, lastEventAt: null, completed24h: null, live: null }),
        googleConnectorCheck({ id: "google:1", name: "Google", apis: [{ id: "gmail", name: "Gmail API" }], live: { checks: [{ id: "gmail", name: "Gmail API", status: "disabled" }], checkedAt: new Date(NOW).toISOString() } }),
      ],
    },
    installation: { access: "locked", reason: "installation_admin_required" },
  }
  const attention = deriveDiagnosticsAttention(sections)
  assert.deepEqual(attention.map((item) => [item.severity, item.code, item.targetId]), [
    ["error", "provider_key_rejected", "b"],
    ["error", "provider_unreachable", "c"],
    ["error", "provider_misconfigured", "d"],
    ["error", "connector_slack_token_rejected", "slack:1"],
    ["warning", "provider_model_missing", "a"],
    ["warning", "desktop_startup_failures", "signed_in"],
    ["warning", "connector_slack_not_installed", "slack:2"],
    ["warning", "connector_google_api_disabled", "google:1"],
  ])
  assert.deepEqual(attention.find((item) => item.code === "provider_model_missing")?.count, 2)
  assert.equal(attention.find((item) => item.code === "provider_model_missing")?.detail, "m1")
  assert.deepEqual([attention[5].count, attention[5].detail], [3, "certificate"])
  assert.equal(attention.find((item) => item.code === "connector_google_api_disabled")?.detail, "Gmail API")
  assert.equal(hasDiagnosticsErrors(attention), true)

  const locked = deriveDiagnosticsAttention({
    desktop: { access: "locked", permission: "desktop_policies.view" },
    providers: { access: "locked", permission: "gateway_providers.view" },
    connectors: { access: "locked", permission: "connections.view" },
    installation: { access: "managed" },
  })
  assert.deepEqual(locked, [], "nothing leaks from locked sections")
  assert.equal(hasDiagnosticsErrors(locked), false)

  const operator = deriveDiagnosticsAttention({
    ...sections,
    providers: { access: "granted", checkedAt: null, checking: false, items: [] },
    connectors: { access: "granted", checkedAt: null, items: [] },
    desktop: summarizeDesktopStartups([], NOW),
    installation: {
      access: "operator",
      server: { version: "dev", startedAt: new Date(NOW).toISOString(), startupMs: 10 },
      services: {
        version: 2, checkedAt: null, checking: false, server: null,
        services: [
          { id: "email", required: false, configured: true, state: "misconfigured", reason: "invalid_configuration", missingSettings: [], dependencies: [], notes: [], durationMs: null, checkedAt: null, lastSuccessAt: null, stale: false },
          { id: "gateway", required: false, configured: false, state: "not_configured", reason: "not_configured", missingSettings: [], dependencies: [], notes: [], durationMs: null, checkedAt: null, lastSuccessAt: null, stale: false },
          { id: "workbot", required: false, configured: true, state: "unreachable", reason: "timeout", missingSettings: [], dependencies: [], notes: [], durationMs: null, checkedAt: null, lastSuccessAt: null, stale: false },
        ],
      },
    },
  })
  assert.deepEqual(operator.map((item) => [item.code, item.subject]), [["service_misconfigured", "Email"], ["service_unreachable", "Workbot"]])
  orgDiagnosticsSchema.shape.attention.parse(operator)
})
