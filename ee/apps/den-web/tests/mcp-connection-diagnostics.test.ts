import { describe, expect, test } from "bun:test";
import {
  consumeMcpDiagnosticStream,
  isMcpDiagnosticStreamMessage,
  isSafeMcpAuthorizationUrl,
  selectMcpDiagnosticTimelineEvents,
} from "../app/(den)/dashboard/_components/mcp-connections-data";

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

  test("retains OAuth discovery fallback candidates while collapsing ordinary phase updates", () => {
    const discoveryOne = { ...event, id: "mde_discovery_1", sequence: 1, phase: "AUTH_ISSUER_DISCOVERY", messageSafe: "RFC 8414 candidate did not match." };
    const discoveryTwo = { ...event, id: "mde_discovery_2", sequence: 2, phase: "AUTH_ISSUER_DISCOVERY", messageSafe: "OIDC candidate matched." };
    const initializeRunning = { ...event, id: "mde_initialize_1", sequence: 3, phase: "MCP_INITIALIZE", outcome: "running" };
    const initializePassed = { ...event, id: "mde_initialize_2", sequence: 4, phase: "MCP_INITIALIZE", outcome: "passed" };

    expect(selectMcpDiagnosticTimelineEvents([
      discoveryOne,
      discoveryTwo,
      initializeRunning,
      initializePassed,
    ]).map((entry) => entry.id)).toEqual(["mde_discovery_1", "mde_discovery_2", "mde_initialize_2"]);
  });

  test("tracks SSE ids for resume and cancels a malformed response body", async () => {
    const encoder = new TextEncoder();
    let lastEventId: string | null = null;
    const validBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`id: 9\ndata: ${JSON.stringify({ type: "event", event, attempt })}\n\n`));
        controller.close();
      },
    });
    const valid = await consumeMcpDiagnosticStream({
      response: new Response(validBody, { headers: { "content-type": "text/event-stream" } }),
      signal: new AbortController().signal,
      onMessage: () => undefined,
      onLastEventId: (value) => { lastEventId = value; },
    });
    expect(valid.lastEventId).toBe("9");
    expect(lastEventId).toBe("9");

    let cancellations = 0;
    const malformedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("id: 10\ndata: {not-json}\n\n"));
      },
      cancel() {
        cancellations += 1;
      },
    });
    await expect(consumeMcpDiagnosticStream({
      response: new Response(malformedBody, { headers: { "content-type": "text/event-stream" } }),
      signal: new AbortController().signal,
      onMessage: () => undefined,
    })).rejects.toThrow("malformed JSON");
    expect(cancellations).toBe(1);
  });

  test("cancels the stream body when the browser aborts", async () => {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancellations += 1;
      },
    });
    const controller = new AbortController();
    const consumption = consumeMcpDiagnosticStream({
      response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
      signal: controller.signal,
      onMessage: () => undefined,
    });
    controller.abort();
    await consumption;
    expect(cancellations).toBe(1);
  });
});
