import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectorCheckReasonSchema,
  connectorCheckStateSchema,
  DESKTOP_STARTUP_STEPS,
  desktopStartupFailureReasonSchema,
  diagnosticsAttentionCodeSchema,
  diagnosticsSectionIdSchema,
  DIAGNOSTICS_SECTION_PERMISSIONS,
  providerCheckReasonSchema,
  providerCheckStateSchema,
  type DiagnosticsAttention,
} from "@openwork/types/den/diagnostics";
import { serviceReadinessStateSchema } from "@openwork/types/den/service-readiness";
import {
  attentionCopy,
  attentionCountLabel,
  CONNECTOR_ACTIONS,
  CONNECTOR_REASON_COPY,
  CONNECTOR_STATE_LABELS,
  CONNECTOR_STATE_TONES,
  DESKTOP_REASON_BADGES,
  DESKTOP_REASON_DETAILS,
  DESKTOP_REASON_NEXT_STEPS,
  DESKTOP_REASON_SHORT,
  DESKTOP_STEP_LABELS,
  lockedSectionCopy,
  PROVIDER_ACTIONS,
  PROVIDER_NEXT_STEPS,
  PROVIDER_REASON_COPY,
  PROVIDER_STATE_LABELS,
  PROVIDER_STATE_TONES,
  SECTION_TITLES,
  SERVICE_STATE_TONES,
} from "./diagnostics-copy";

function attention(overrides: Partial<DiagnosticsAttention>): DiagnosticsAttention {
  return { section: "providers", targetId: "row", severity: "warning", code: "provider_unreachable", subject: "LiteLLM", count: null, detail: null, ...overrides };
}

/** Sentence case, no middle-dot meta, no arrows, no raw codes (DESIGN.md C3, C7). */
function assertCopy(value: string, label: string) {
  assert.ok(value.trim().length > 0, `${label} is empty`);
  assert.doesNotMatch(value, /·|→|_/, label);
  assert.equal(value.charAt(0), value.charAt(0).toUpperCase(), `${label} starts lowercase: ${value}`);
}

test("every contract value has user-facing copy", () => {
  for (const id of diagnosticsSectionIdSchema.options) assertCopy(SECTION_TITLES[id], id);
  for (const step of DESKTOP_STARTUP_STEPS) assertCopy(DESKTOP_STEP_LABELS[step], step);
  for (const reason of desktopStartupFailureReasonSchema.options) {
    assert.match(DESKTOP_REASON_SHORT[reason], /^[a-z]/, reason);
    assertCopy(DESKTOP_REASON_BADGES[reason], reason);
    assertCopy(DESKTOP_REASON_DETAILS[reason], reason);
    assertCopy(DESKTOP_REASON_NEXT_STEPS[reason], reason);
  }
  for (const state of providerCheckStateSchema.options) {
    assertCopy(PROVIDER_STATE_LABELS[state], state);
    assert.ok(PROVIDER_STATE_TONES[state]);
    // A row that needs fixing names the next step and offers one action, and vice versa.
    assert.equal(PROVIDER_NEXT_STEPS[state] === null, PROVIDER_ACTIONS[state] === null, state);
  }
  for (const reason of providerCheckReasonSchema.options) assertCopy(PROVIDER_REASON_COPY[reason], reason);
  for (const state of connectorCheckStateSchema.options) {
    assertCopy(CONNECTOR_STATE_LABELS[state], state);
    assert.ok(CONNECTOR_STATE_TONES[state]);
  }
  for (const reason of connectorCheckReasonSchema.options) {
    assertCopy(CONNECTOR_REASON_COPY[reason], reason);
    const action = CONNECTOR_ACTIONS[reason];
    if (action) assertCopy(action, reason);
  }
  for (const state of serviceReadinessStateSchema.options) assert.ok(SERVICE_STATE_TONES[state]);
});

test("red is only for failures; ready, managed and locked states stay calm", () => {
  assert.equal(PROVIDER_STATE_TONES.ready, "success");
  for (const state of ["member_credentials", "managed", "not_checked"] as const) assert.equal(PROVIDER_STATE_TONES[state], "neutral");
  assert.equal(SERVICE_STATE_TONES.not_configured, "neutral");
  assert.equal(SERVICE_STATE_TONES.unknown, "neutral");
  assert.equal(SERVICE_STATE_TONES.unreachable, "danger");
});

test("every attention code reads as a sentence with one action", () => {
  for (const code of diagnosticsAttentionCodeSchema.options) {
    const copy = attentionCopy(attention({ code, count: 2, detail: code === "desktop_startup_failures" ? "dns" : "claude-opus-5" }));
    assertCopy(copy.text.replace(/^\d+ /, "X "), code);
    assertCopy(copy.action, code);
    assert.doesNotMatch(copy.text, new RegExp(code), code);
  }
});

test("attention examples match the approved wording", () => {
  assert.deepEqual(attentionCopy(attention({ code: "provider_key_rejected" })), { text: "LiteLLM rejected the API key", action: "Update key" });
  assert.equal(attentionCopy(attention({ code: "provider_model_missing", subject: "Amazon Bedrock", count: 1, detail: "claude-opus-5" })).text, "Amazon Bedrock doesn't serve claude-opus-5");
  assert.equal(attentionCopy(attention({ code: "provider_model_missing", subject: "Amazon Bedrock", count: 3, detail: "claude-opus-5" })).text, "Amazon Bedrock doesn't serve claude-opus-5 and 2 more");
  assert.equal(attentionCopy(attention({ code: "provider_model_missing" })).action, "Fix models");
  assert.deepEqual(
    attentionCopy(attention({ section: "desktop", targetId: "signed_in", code: "desktop_startup_failures", count: 3, detail: "certificate" })),
    { text: "3 desktop startups couldn't reach OpenWork: certificate not trusted", action: "See details" },
  );
  assert.equal(attentionCopy(attention({ code: "desktop_startup_failures", count: 1, detail: "made_up" })).text, "1 desktop startup couldn't reach OpenWork: unknown error");
  assert.equal(attentionCountLabel(1), "1 needs attention");
  assert.equal(attentionCountLabel(3), "3 need attention");
});

test("locked sections name the missing permission in plain words and who can grant it", () => {
  assert.deepEqual(lockedSectionCopy(DIAGNOSTICS_SECTION_PERMISSIONS.desktop), { name: "Requires permission to view desktop policies", sub: "Ask an organization owner or admin" });
  for (const permission of Object.values(DIAGNOSTICS_SECTION_PERMISSIONS)) {
    const copy = lockedSectionCopy(permission);
    assert.match(copy.name, /^Requires permission to view /);
    assert.doesNotMatch(copy.name, /\./);
  }
  assert.equal(lockedSectionCopy("not.a.permission").name, "Requires an organization permission");
});
