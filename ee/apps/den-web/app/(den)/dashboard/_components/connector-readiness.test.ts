import assert from "node:assert/strict";
import { test } from "node:test";
import { connectorNeedsFirstCheck, connectorReadinessNote, connectorReadinessState } from "./connector-readiness";
import type { ConnectionReadiness, ExternalMcpConnection } from "./mcp-connections-data";

const checkedAt = "2026-10-22T12:00:00.000Z";
const ready: ConnectionReadiness = { status: "ready", checkedAt, lastSuccessfulAt: checkedAt, reason: null, failure: null };
const down: ConnectionReadiness = { status: "could_not_verify", checkedAt, lastSuccessfulAt: null, reason: "The service didn't respond. Try again later.", failure: "unavailable" };
const rejected: ConnectionReadiness = { status: "could_not_verify", checkedAt, lastSuccessfulAt: null, reason: "The service rejected the sign-in. Sign in again.", failure: "sign_in_rejected" };

function connection(overrides: Partial<ExternalMcpConnection> = {}): ExternalMcpConnection {
  return {
    id: "emc_1", name: "Notes", url: "https://notes.example.test/mcp", authType: "apikey", credentialMode: "shared",
    apiKeyAuthScheme: "bearer", exposeDirectly: false, connected: true, connectedAt: checkedAt, updatedAt: checkedAt,
    connectedForMe: true, requiredBy: [], identityManagedBy: [], access: null, readiness: null, ...overrides,
  };
}

test("never checked is Not checked, not a failure, and never says both", () => {
  const unchecked = connection();
  assert.equal(connectorReadinessState(unchecked), "Not checked");
  assert.equal(connectorReadinessNote(unchecked), "Not checked yet.");
  assert.notEqual(connectorReadinessState(unchecked), "Couldn't verify");
});

test("checking, verified and failed are distinct", () => {
  assert.equal(connectorReadinessState(connection(), { checking: true }), "Checking…");
  assert.equal(connectorReadinessState(connection({ readiness: ready })), "Ready");
  assert.match(connectorReadinessNote(connection({ readiness: ready })) ?? "", /^Checked /);
  assert.equal(connectorReadinessState(connection({ readiness: down })), "Couldn't verify");
  assert.equal(connectorReadinessNote(connection({ readiness: down })), down.reason);
  assert.match(connectorReadinessNote(connection({ readiness: { ...down, lastSuccessfulAt: checkedAt } })) ?? "", /Last ready/);
});

test("only a rejected or missing sign-in asks to sign in; outages and bad settings do not", () => {
  assert.equal(connectorReadinessState(connection({ readiness: rejected })), "Sign in");
  assert.equal(connectorReadinessNote(connection({ readiness: rejected })), rejected.reason);
  for (const failure of ["unavailable", "timed_out", "tools_unreadable", "settings_changed"] as const) {
    assert.equal(connectorReadinessState(connection({ readiness: { ...down, failure } })), "Couldn't verify", failure);
  }
  // Checks recorded before failures were classified are failures, not sign-in problems.
  assert.equal(connectorReadinessState(connection({ readiness: { ...down, failure: undefined } })), "Couldn't verify");
});

test("a member who has not signed in to a per-member connection is asked to sign in", () => {
  const personal = connection({ credentialMode: "per_member", connectedForMe: false });
  assert.equal(connectorReadinessState(personal), "Sign in");
  assert.equal(connectorReadinessNote(personal), undefined);
});

test("admins see the connector's own status: another member's Ready shows Ready, not the admin's missing sign-in", () => {
  const personal = connection({ credentialMode: "per_member", connected: true, connectedForMe: false, readiness: null, organizationReadiness: ready });
  assert.equal(connectorReadinessState(personal, { organization: true }), "Ready");
  // The same connection in the admin's own view still needs their sign-in.
  assert.equal(connectorReadinessState(personal), "Sign in");
  // Nobody checked it and the admin is not signed in: sign in, not a failure.
  assert.equal(connectorReadinessState({ ...personal, organizationReadiness: null }, { organization: true }), "Sign in");
});

test("setup problems win over any stored check, and older servers show no status", () => {
  assert.equal(connectorReadinessState(connection({ connected: false, readiness: ready })), "Set up");
  assert.equal(connectorReadinessState(connection({ setupRequired: true, readiness: ready })), "Set up");
  assert.equal(connectorReadinessState(connection({ readiness: undefined })), null);
  // Older server without connector-level status: the admin list falls back to the caller's own.
  assert.equal(connectorReadinessState(connection({ readiness: ready }), { organization: true }), "Ready");
});

test("the admin list only asks to check connectors nobody checked that someone could check", () => {
  assert.equal(connectorNeedsFirstCheck(connection({ organizationReadiness: null })), true);
  assert.equal(connectorNeedsFirstCheck(connection({ organizationReadiness: ready })), false);
  assert.equal(connectorNeedsFirstCheck(connection({ organizationReadiness: down })), false, "a stored failure is re-checked only on request");
  assert.equal(connectorNeedsFirstCheck(connection({ organizationReadiness: undefined })), false, "older server");
  assert.equal(connectorNeedsFirstCheck(connection({ organizationReadiness: null, connected: false })), false, "shared credential missing");
  assert.equal(connectorNeedsFirstCheck(connection({ credentialMode: "per_member", connected: true, connectedForMe: false, organizationReadiness: null })), true, "a member signed in; their check may be copied");
});
