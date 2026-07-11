import { describe, expect, test } from "bun:test";
import { isMcpDiagnosticStreamMessage, isSafeMcpAuthorizationUrl } from "../app/(den)/dashboard/_components/mcp-connections-data";

const event = {
  id: "mde_01h2xcejqtf2nbrexx3vqjhp41",
  attemptId: "mda_01h2xcejqtf2nbrexx3vqjhp41",
  sequence: 1,
  occurredAt: "2026-07-10T00:00:00.000Z",
  phase: "MCP_VERSION",
  outcome: "failed",
  elapsedMs: 125,
  phaseDurationMs: 25,
  healthLevel: "authorized",
  messageSafe: "The client and server did not agree on a supported stable MCP revision.",
  category: "mcp_version",
  retryable: false,
  actionOwner: "provider_admin",
  operatorAction: "align_provider_and_client_mcp_versions",
  evidence: {
    origin: "https://example.service-now.com",
    path: "/sncapps/mcp-server/mcp/{server}",
    protocolVersion: "2025-06-18",
    detailsRedacted: true,
  },
};

const attempt = {
  id: event.attemptId,
  connectionId: "emc_01h2xcejqtf2nbrexx3vqjhp41",
  status: "running",
  highestHealthLevel: "authorized",
  firstFailedPhase: null,
  firstFailureCategory: null,
  firstFailureMessage: null,
  actionOwner: null,
  operatorAction: null,
  startedAt: "2026-07-10T00:00:00.000Z",
  completedAt: null,
  expiresAt: "2026-07-11T00:00:00.000Z",
};

describe("MCP diagnostic stream contract", () => {
  test("accepts a canonical redacted event", () => {
    expect(isMcpDiagnosticStreamMessage({ type: "event", event, attempt })).toBe(true);
  });

  test("rejects unknown phases and evidence fields that could carry secrets", () => {
    expect(isMcpDiagnosticStreamMessage({ type: "event", event: { ...event, phase: "NETWORK" }, attempt })).toBe(false);
    expect(isMcpDiagnosticStreamMessage({
      type: "event",
      event: { ...event, evidence: { ...event.evidence, authorizationCode: "secret" } },
      attempt,
    })).toBe(false);
  });

  test("keeps authorization URLs in an ephemeral control message only", () => {
    expect(isMcpDiagnosticStreamMessage({
      type: "authorization_required",
      authorizeUrl: "https://login.example.test/authorize?state=opaque",
    })).toBe(true);
    expect(isMcpDiagnosticStreamMessage({
      type: "authorization_required",
      authorizeUrl: "https://login.example.test/authorize",
      token: "must-not-be-accepted",
    })).toBe(false);
  });

  test("allows only credential-free HTTP(S) authorization URLs", () => {
    expect(isSafeMcpAuthorizationUrl("https://login.example.test/authorize?state=opaque")).toBe(true);
    expect(isSafeMcpAuthorizationUrl("http://127.0.0.1:3978/authorize")).toBe(true);
    expect(isSafeMcpAuthorizationUrl("http://localhost:3978/authorize")).toBe(true);
    expect(isSafeMcpAuthorizationUrl("http://login.example.test/authorize")).toBe(false);
    expect(isSafeMcpAuthorizationUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeMcpAuthorizationUrl("data:text/html,unsafe")).toBe(false);
    expect(isSafeMcpAuthorizationUrl("https://user:password@login.example.test/authorize")).toBe(false);
    expect(isMcpDiagnosticStreamMessage({ type: "authorization_required", authorizeUrl: "javascript:alert(1)" })).toBe(false);
  });
});
