import { expect, test } from "bun:test";
import { parseConnectionReadiness, type DenExternalMcpConnection } from "../src/app/lib/den";
import {
  connectPollOutcome,
  providerSettingsLink,
  providerSetupProblem,
} from "../src/react-app/domains/connections/connection-sign-in-problem";
import { recordedConnectorNote, recordedConnectorState } from "../src/react-app/domains/settings/connector-readiness";

const REASON = "The service needs a setting changed before it can connect. Ask whoever manages the service's app to check its settings.";
const SETTINGS = "https://api.slack.com/apps/A0FIXTURE/app-assistant";
const started = Date.parse("2026-10-28T12:00:00.000Z");

function connection(overrides: Partial<DenExternalMcpConnection> = {}): DenExternalMcpConnection {
  return {
    id: "emc_chat", name: "Acme Chat", url: "https://mcp.chat.acme.test/mcp", authType: "oauth", credentialMode: "per_member",
    exposeDirectly: false, connected: true, connectedAt: null, connectedForMe: false,
    ...overrides,
  };
}

const blocked = connection({
  needsReconnect: true,
  readiness: {
    status: "could_not_verify", checkedAt: "2026-10-28T12:00:20.000Z", lastSuccessfulAt: null,
    reason: REASON, failure: "provider_setup_required", referenceId: "ref-fixture", providerSettingsUrl: SETTINGS,
  },
});

test("Den's readiness keeps the new failure, its reference and settings link, and tolerates older Den", () => {
  expect(parseConnectionReadiness({
    status: "could_not_verify", checkedAt: "2026-10-28T12:00:20.000Z", reason: REASON,
    failure: "provider_setup_required", referenceId: "ref-fixture", providerSettingsUrl: SETTINGS,
  })).toEqual({
    status: "could_not_verify", checkedAt: "2026-10-28T12:00:20.000Z", lastSuccessfulAt: null, reason: REASON,
    failure: "provider_setup_required", referenceId: "ref-fixture", providerSettingsUrl: SETTINGS,
  });
  expect(parseConnectionReadiness({ status: "could_not_verify", checkedAt: "2026-10-28T12:00:20.000Z", reason: "Older Den.", failure: "something_new" }))
    .toEqual({ status: "could_not_verify", checkedAt: "2026-10-28T12:00:20.000Z", lastSuccessfulAt: null, reason: "Older Den.", failure: null });
});

test("only an https Slack app settings page is opened, and its label never comes from the link", () => {
  expect(providerSettingsLink(SETTINGS, "Acme Chat")).toEqual({ url: SETTINGS, label: "Open Slack app settings" });
  expect(providerSettingsLink("http://api.slack.com/apps/A0FIXTURE", "Acme Chat")).toBeNull();
  expect(providerSettingsLink("https://api.slack.com.evil.test/apps", "Acme Chat")).toBeNull();
  expect(providerSettingsLink("https://evil.test/?u=https://api.slack.com", "Acme Chat")).toBeNull();
  expect(providerSettingsLink("https://user:pass@api.slack.com/apps", "Acme Chat")).toBeNull();
  expect(providerSettingsLink("https://api.slack.com:8443/apps", "Acme Chat")).toBeNull();
  expect(providerSettingsLink("javascript:alert(1)", "Acme Chat")).toBeNull();
  expect(providerSettingsLink("not a url", "Acme Chat")).toBeNull();
  expect(providerSettingsLink(undefined, "Acme Chat")).toBeNull();
});

test("polling stops at the first failed check recorded for this attempt and carries Den's reason", () => {
  const attempt = { startedAt: started, previousCheckedAt: null };
  const outcome = connectPollOutcome(blocked, attempt, { previousConnectedAt: null, reconnectPending: true });
  expect(outcome).toEqual({
    kind: "failed",
    problem: { failure: "provider_setup_required", reason: REASON, settings: { url: SETTINGS, label: "Open Slack app settings" } },
  });
});

test("an older failure, or one already seen before the attempt, keeps polling", () => {
  const stale = connection({ readiness: { ...blocked.readiness!, checkedAt: "2026-10-28T11:50:00.000Z" } });
  expect(connectPollOutcome(stale, { startedAt: started, previousCheckedAt: null }, { previousConnectedAt: null, reconnectPending: false }))
    .toEqual({ kind: "waiting" });
  expect(connectPollOutcome(blocked, { startedAt: started, previousCheckedAt: "2026-10-28T12:00:20.000Z" }, { previousConnectedAt: null, reconnectPending: true }))
    .toEqual({ kind: "waiting" });
});

test("a fresh connection still finishes the attempt", () => {
  const connected = connection({ connectedForMe: true, connectedAt: "2026-10-28T12:00:30.000Z" });
  expect(connectPollOutcome(connected, { startedAt: started, previousCheckedAt: null }, { previousConnectedAt: null, reconnectPending: false }))
    .toEqual({ kind: "connected" });
  expect(connectPollOutcome(connected, { startedAt: started, previousCheckedAt: null }, { previousConnectedAt: "2026-10-28T12:00:30.000Z", reconnectPending: false }))
    .toEqual({ kind: "waiting" });
});

test("a blocking provider setting wins over needsReconnect on the Library row", () => {
  expect(providerSetupProblem(blocked)?.reason).toBe(REASON);
  expect(recordedConnectorState(blocked)).toBe("Change setting");
  expect(recordedConnectorNote(blocked)).toBe(REASON);
  // Other failures keep their existing states.
  const rejected = connection({ needsReconnect: true, readiness: { ...blocked.readiness!, failure: "sign_in_rejected", providerSettingsUrl: undefined } });
  expect(providerSetupProblem(rejected)).toBeNull();
  expect(recordedConnectorState(rejected)).toBe("Sign in");
});
