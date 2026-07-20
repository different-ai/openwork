import { afterEach, describe, expect, test } from "bun:test";
import {
  DenRequestCanceledError,
  DenRequestTimeoutError,
  requestJson,
} from "../app/(den)/_lib/den-flow";
import {
  attributeExternalMcpToolFailure,
  parseExternalMcpDiagnostic,
} from "../app/(den)/dashboard/_components/mcp-tool-error-attribution";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function abortingFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const rejectAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (!signal) {
      reject(new Error("Expected an abort signal."));
      return;
    }
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

describe("browser-to-Den timeout", () => {
  test("throws a typed unknown-outcome error for the dashboard-created deadline", async () => {
    globalThis.fetch = abortingFetch;
    const error = await requestJson("/v1/mcp-connections/test/tools/call", {}, 5).catch((failure) => failure);

    expect(error).toBeInstanceOf(DenRequestTimeoutError);
    if (!(error instanceof DenRequestTimeoutError)) throw new Error("Expected DenRequestTimeoutError");
    expect(error.timeoutMs).toBe(5);
    expect(error.outcome).toBe("unknown");
    expect(error.message).toBe(
      "OpenWork stopped waiting after 5 milliseconds. The operation’s outcome is unknown.",
    );
    expect(new DenRequestTimeoutError(160_000).message).toBe(
      "OpenWork stopped waiting after 160 seconds. The operation’s outcome is unknown.",
    );
  });

  test("distinguishes a caller cancellation without exposing AbortError", async () => {
    globalThis.fetch = abortingFetch;
    const controller = new AbortController();
    controller.abort();
    const error = await requestJson(
      "/v1/mcp-connections/test/tools/call",
      { signal: controller.signal },
      5,
    ).catch((failure) => failure);

    expect(error).not.toBeInstanceOf(DenRequestTimeoutError);
    expect(error).toBeInstanceOf(DenRequestCanceledError);
    if (!(error instanceof DenRequestCanceledError)) throw new Error("Expected DenRequestCanceledError");
    expect(error.name).toBe("DenRequestCanceledError");
    expect(error.outcome).toBe("unknown");
  });
});

describe("MCP failure attribution", () => {
  test("marks a Den lifecycle deadline after tools/call as inferred and unknown", () => {
    const attribution = attributeExternalMcpToolFailure({
      diagnostic: {
        referenceId: "req_deadline",
        phase: "MCP_TOOL_EXECUTION",
        category: "lifecycle_deadline",
        code: "MCP_LIFECYCLE_DEADLINE",
        retryable: true,
        actionOwner: "provider_admin",
      },
      inspection: { request: {} },
      browserTimeout: null,
      mayHaveSideEffects: false,
    });

    expect(attribution).toMatchObject({
      summary: "OpenWork sent the request, but the remote MCP did not respond before OpenWork’s deadline.",
      lastConfirmedBoundary: "OpenWork started the outbound tools/call",
      likelySource: "Network or remote MCP",
      confidence: "Inferred",
      outcome: "unknown",
      diagnosticReference: "req_deadline",
      diagnosticCode: "MCP_LIFECYCLE_DEADLINE",
    });
  });

  test.each([408, 504])("attributes remote MCP HTTP %d responses as confirmed", (status) => {
    const attribution = attributeExternalMcpToolFailure({
      diagnostic: { referenceId: `req_${status}`, retryable: true, httpStatus: status },
      inspection: { request: {}, response: { status, headers: [] } },
      browserTimeout: null,
      mayHaveSideEffects: false,
    });

    expect(attribution).toMatchObject({
      summary: `The remote MCP returned HTTP ${status}.`,
      lastConfirmedBoundary: `Remote MCP returned HTTP ${status}`,
      likelySource: "Remote MCP",
      confidence: "Confirmed",
      outcome: "failed",
    });
  });

  test("attributes an MCP/provider error returned through HTTP 200", () => {
    const attribution = attributeExternalMcpToolFailure({
      diagnostic: {
        referenceId: "req_provider",
        phase: "PROVIDER_AUTHORIZATION",
        category: "provider_policy_denied",
        code: "MCP_PROVIDER_HTTP_403",
        retryable: false,
        actionOwner: "provider_admin",
        providerStatus: 403,
        providerRequestId: "provider-request-123",
      },
      inspection: { request: {}, response: { status: 200, headers: [] } },
      browserTimeout: null,
      mayHaveSideEffects: false,
    });

    expect(attribution).toMatchObject({
      summary: "The remote MCP responded, but the downstream provider rejected the operation.",
      lastConfirmedBoundary: "Remote MCP returned HTTP 200 with a tool error",
      likelySource: "Downstream provider",
      confidence: "Confirmed",
      providerRequestId: "provider-request-123",
    });
  });

  test("attributes an OpenWork block before send as confirmed", () => {
    const attribution = attributeExternalMcpToolFailure({
      diagnostic: {
        referenceId: "req_blocked",
        phase: "CONFIGURATION",
        category: "security_blocked",
        code: "MCP_URL_BLOCKED",
        retryable: false,
        actionOwner: "organization_admin",
      },
      // The inspector captures before the SSRF guard, so this request record
      // does not prove that anything left Den.
      inspection: { request: {} },
      browserTimeout: null,
      mayHaveSideEffects: true,
    });

    expect(attribution).toMatchObject({
      summary: "OpenWork blocked the request before it was sent.",
      lastConfirmedBoundary: "OpenWork evaluated the outbound request",
      likelySource: "OpenWork",
      confidence: "Confirmed",
      outcome: "failed",
    });
  });

  test("warns against immediately retrying a destructive tool with unknown outcome", () => {
    const attribution = attributeExternalMcpToolFailure({
      diagnostic: null,
      inspection: null,
      browserTimeout: { timeoutMs: 160_000, outcome: "unknown" },
      mayHaveSideEffects: true,
    });

    expect(attribution.summary).toBe(
      "OpenWork stopped waiting after 160 seconds. The operation’s outcome is unknown.",
    );
    expect(attribution.retryGuidance).toContain("Do not retry immediately");
    expect(attribution.retryGuidance).toContain("may have changed external data");
  });

  test("parses current diagnostics and falls back to wire evidence across deploy skew", () => {
    expect(parseExternalMcpDiagnostic({
      referenceId: "req_full",
      phase: "FUTURE_PROVIDER_PHASE",
      category: "provider_error",
      code: "MCP_PROVIDER_ERROR",
      retryable: false,
      actionOwner: "provider_admin",
      operatorAction: "Inspect provider logs.",
      message: "Safe provider failure.",
      highestPassed: "operation_ready",
      httpStatus: 200,
      operationPhase: "MCP_TOOL_EXECUTION",
      providerStatus: 403,
      providerRequestId: "provider-request-456",
      providerCode: "access_denied",
    })).toEqual({
      referenceId: "req_full",
      phase: "FUTURE_PROVIDER_PHASE",
      category: "provider_error",
      code: "MCP_PROVIDER_ERROR",
      retryable: false,
      actionOwner: "provider_admin",
      operatorAction: "Inspect provider logs.",
      message: "Safe provider failure.",
      highestPassed: "operation_ready",
      httpStatus: 200,
      operationPhase: "MCP_TOOL_EXECUTION",
      providerStatus: 403,
      providerRequestId: "provider-request-456",
      providerCode: "access_denied",
    });

    const attribution = attributeExternalMcpToolFailure({
      diagnostic: null,
      inspection: {
        request: {},
        response: {
          status: 504,
          headers: [{ name: "x-request-id", value: "wire-request-789", redacted: false }],
        },
        diagnosis: { layer: "remote_http", summary: "Older OpenWork failure shape." },
      },
      browserTimeout: null,
      mayHaveSideEffects: false,
    });
    expect(attribution).toMatchObject({
      summary: "The remote MCP returned HTTP 504.",
      confidence: "Confirmed",
      providerRequestId: "wire-request-789",
    });
  });
});
