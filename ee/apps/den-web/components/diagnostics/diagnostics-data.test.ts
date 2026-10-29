import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attentionFor,
  DIAGNOSTICS_POLL_LIMIT_MS,
  desktopStepSegments,
  desktopSummaryState,
  diagnosticsReportText,
  diagnosticsRowId,
  formatAgo,
  formatDuration,
  formatUptime,
  isChecking,
  latestCheckedAt,
  orderAttention,
  overallStatus,
  parseOrgDiagnostics,
  providerAvailableModels,
  retryAfterSeconds,
  shouldPollDiagnostics,
} from "./diagnostics-data";
import { lockedReport, NOW, provider, report, services, TWO_MIN_AGO } from "./diagnostics-test-fixtures";

test("reports parse strictly: unknown fields, codes and versions are rejected", () => {
  const value = report();
  assert.deepEqual(parseOrgDiagnostics(value), value);
  assert.deepEqual(parseOrgDiagnostics(lockedReport()), lockedReport());
  assert.equal(parseOrgDiagnostics({ ...value, version: 2 }), null);
  assert.equal(parseOrgDiagnostics({ ...value, secret: "https://private.example.test" }), null);
  assert.equal(parseOrgDiagnostics({ ...value, attention: [{ ...value.attention[0], code: "made_up" }] }), null);
  assert.equal(parseOrgDiagnostics({ ...value, installation: { access: "operator", server: value.installation.access === "operator" ? value.installation.server : null } }), null);
  assert.equal(parseOrgDiagnostics(null), null);
});

test("attention lists errors first and keeps the server's order within a severity", () => {
  const ordered = orderAttention(report().attention);
  assert.deepEqual(ordered.map((item) => item.subject), ["LiteLLM", "Desktop app", "Amazon Bedrock"]);
  const warnings = orderAttention([
    { section: "installation", targetId: "email", severity: "warning", code: "service_misconfigured", subject: "Email", count: null, detail: null },
    { section: "providers", targetId: "a", severity: "warning", code: "provider_misconfigured", subject: "A", count: null, detail: null },
  ]);
  assert.deepEqual(warnings.map((item) => item.subject), ["Email", "A"]);
  assert.equal(attentionFor(report(), "providers", "gateway:litellm:default")?.severity, "error");
  assert.equal(attentionFor(report(), "providers", "nothing"), undefined);
});

test("the status line counts what needs attention, otherwise says everything works only after a check", () => {
  assert.deepEqual(overallStatus(report()), { kind: "attention", count: 3, severity: "error" });
  assert.deepEqual(overallStatus(report({ attention: report().attention.filter((item) => item.severity === "warning") })), { kind: "attention", count: 2, severity: "warning" });
  assert.deepEqual(overallStatus(report({ attention: [] })), { kind: "working" });
  assert.deepEqual(overallStatus(lockedReport()), { kind: "not_checked" });
  assert.equal(latestCheckedAt(lockedReport()), null);
  assert.equal(latestCheckedAt(report()), TWO_MIN_AGO);
});

test("polling runs every 2 s only while something is checking and the 30 s window is open", () => {
  const idle = report();
  const running = report({ checking: true });
  assert.equal(isChecking(idle), false);
  assert.equal(isChecking(running), true);
  assert.equal(isChecking(report({ providers: { access: "granted", checkedAt: null, checking: true, items: [] } })), true);
  assert.equal(isChecking(report({ installation: { access: "operator", server: services().server ?? { version: "1", startedAt: TWO_MIN_AGO, startupMs: null }, services: { ...services(), checking: true } } })), true);
  assert.equal(shouldPollDiagnostics(running, NOW + DIAGNOSTICS_POLL_LIMIT_MS, NOW), true);
  assert.equal(shouldPollDiagnostics(running, NOW, NOW), false);
  assert.equal(shouldPollDiagnostics(running, null, NOW), false);
  assert.equal(shouldPollDiagnostics(idle, NOW + DIAGNOSTICS_POLL_LIMIT_MS, NOW), false);
  assert.equal(shouldPollDiagnostics(undefined, NOW + DIAGNOSTICS_POLL_LIMIT_MS, NOW), false);
});

test("Retry-After is honored only as bounded whole seconds", () => {
  assert.equal(retryAfterSeconds("17"), 17);
  for (const value of [null, "", "-1", "0", "3601", "999999999999999999", "Infinity", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT", "private upstream failure"]) {
    assert.equal(retryAfterSeconds(value), undefined, String(value));
  }
});

test("rows get stable, safe anchor ids", () => {
  assert.equal(diagnosticsRowId("providers", "gateway:litellm:default"), "diagnostics-providers-gateway-litellm-default");
  assert.equal(diagnosticsRowId("desktop", "signed_in"), "diagnostics-desktop-signed_in");
  assert.doesNotMatch(diagnosticsRowId("connectors", "a b\"<c>"), /[\s"<>]/);
});

test("Copy report is the response as pretty JSON", () => {
  const value = report();
  const text = diagnosticsReportText(value);
  assert.deepEqual(JSON.parse(text), value);
  assert.match(text, /\n {2}"version": 1/);
});

test("desktop steps share the bar in launch order and summarize health", () => {
  const desktop = report().desktop;
  if (desktop.access !== "granted") throw new Error("granted fixture");
  const segments = desktopStepSegments(desktop);
  assert.deepEqual(segments.map((segment) => segment.step), ["window", "engine", "signed_in", "org_tools"]);
  assert.equal(Math.round(segments.reduce((sum, segment) => sum + segment.percent, 0)), 100);
  assert.deepEqual(desktopStepSegments({ ...desktop, steps: [{ step: "org_tools", typicalMs: null }] }), []);
  assert.equal(desktopSummaryState(desktop), "some_failed");
  assert.equal(desktopSummaryState({ ...desktop, failed: 0 }), "healthy");
  assert.equal(desktopSummaryState({ ...desktop, connected: 0 }), "not_connecting");
  assert.equal(desktopSummaryState({ ...desktop, startups: 0 }), "no_data");
});

test("available models subtract missing ones, and an unlisted endpoint has no count", () => {
  assert.equal(providerAvailableModels(provider()), 3);
  assert.equal(providerAvailableModels(provider({ models: { configured: 3, served: 30, missing: ["x"] } })), 2);
  assert.equal(providerAvailableModels(provider({ models: { configured: 0, served: 12, missing: [] } })), 12);
  assert.equal(providerAvailableModels(provider({ models: { configured: 3, served: null, missing: [] } })), null);
});

test("durations and times read like people talk", () => {
  assert.equal(formatDuration(3), "3 ms");
  assert.equal(formatDuration(41), "41 ms");
  assert.equal(formatDuration(1_800), "1.8 s");
  assert.equal(formatDuration(4_150), "4.2 s");
  assert.equal(formatDuration(12_400), "12 s");
  assert.equal(formatDuration(120_000), "2 min");
  assert.equal(formatAgo(null, NOW), null);
  assert.equal(formatAgo("invalid", NOW), null);
  assert.equal(formatAgo("2026-10-20T15:59:30.000Z", NOW), "just now");
  assert.equal(formatAgo(TWO_MIN_AGO, NOW), "2 min ago");
  assert.equal(formatAgo("2026-10-20T13:00:00.000Z", NOW), "3 h ago");
  assert.equal(formatAgo("2026-10-19T16:00:00.000Z", NOW), "1 day ago");
  assert.equal(formatAgo("2026-10-01T16:00:00.000Z", NOW), "Oct 1");
  assert.equal(formatAgo("2026-10-21T16:00:00.000Z", NOW), "just now");
  assert.equal(formatUptime("2026-10-20T13:00:00.000Z", NOW), "Up 3 h");
  assert.equal(formatUptime("bad", NOW), null);
});
