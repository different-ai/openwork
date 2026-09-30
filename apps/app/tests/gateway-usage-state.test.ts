import { describe, expect, test } from "bun:test";
import { gatewayUsageLimitResponse } from "@openwork/types/den/gateway-usage-limits";
import { corroboratesGatewayUsageError, gatewayUsageErrorEvidenceSchema, formatGatewayMoney, isGatewayUsageModel, gatewayUsageNoticeState, gatewayUsageRefreshKey, gatewayUsageResetDelay, parseGatewayUsageError } from "../src/react-app/domains/cloud/gateway-usage-state";
import { presentOpencodeSessionError, sessionErrorPresentationFromUIMessage } from "../src/react-app/domains/session/sync/session-error";
import { createSessionErrorUIMessage } from "../src/react-app/domains/session/sync/usechat-adapter";
import { mapV2SessionError, createV2EventTranslationState, translateV2Event } from "../src/app/lib/opencode-v2-adapter";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest, trackWorkspaceSessionSync, transcriptKey } from "../src/react-app/domains/session/sync/session-sync";
import type { UIMessage } from "ai";
import { usageStatus } from "./gateway-usage-fixture";

async function gatewayError() {
  const response = gatewayUsageLimitResponse(usageStatus());
  if (!response) throw new Error("Expected exhaustion");
  return { name: "APIError", data: { statusCode: response.status, responseHeaders: Object.fromEntries(response.headers), responseBody: await response.text(), isRetryable: false, message: "Localized provider message" } };
}

describe("Gateway usage error contract", () => {
  test("uses the actual shared Gateway response, not message matching", async () => {
    const error = await gatewayError();
    expect(parseGatewayUsageError(error)?.details.exhaustedBuckets[0].bucketId).toBe("bucket_test");
    const presentation = presentOpencodeSessionError(error);
    expect(presentation.kind).toBe("generic");
    expect(corroboratesGatewayUsageError(presentation.gatewayUsage ?? null, usageStatus())).toBe(true);
    expect(sessionErrorPresentationFromUIMessage(createSessionErrorUIMessage("turn", presentation))).toEqual(presentation);
    expect(parseGatewayUsageError({ cause: error })).not.toBeNull();
  });
  test("preserves supplied native HTTP error metadata through Desktop adaptation", async () => {
    const error = await gatewayError();
    expect(parseGatewayUsageError(mapV2SessionError(error))).toEqual(parseGatewayUsageError(error));
    expect(parseGatewayUsageError(mapV2SessionError(error.data))).toEqual(parseGatewayUsageError(error));
    expect(parseGatewayUsageError(mapV2SessionError({ message: error.data.message }))).toBeNull();
  });
  test("native failed events reach the transcript and invalidate own usage", async () => {
    const input = { workspaceId: "workspace_test", baseUrl: "http://127.0.0.1:1234", openworkToken: "test-token" };
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    const release = trackWorkspaceSessionSync(input, "session_test");
    const client = getReactQueryClient();
    client.setQueryData(["gateway-own-usage", "test-scope"], usageStatus());
    try {
      const events = translateV2Event({ type: "session.execution.failed", data: { sessionID: "session_test", error: (await gatewayError()).data } }, createV2EventTranslationState());
      if (!events) throw new Error("Missing native event");
      for (const event of events) __applySessionSyncEventForTest(input, event);
      const transcript = client.getQueryData<UIMessage[]>(transcriptKey("workspace_test", "session_test"));
      const message = transcript?.at(-1);
      if (!message) throw new Error("Missing error message");
      expect(sessionErrorPresentationFromUIMessage(message)?.gatewayUsage?.details.exhaustedBuckets[0].bucketId).toBe("bucket_test");
      expect(client.getQueryState(["gateway-own-usage", "test-scope"])?.isInvalidated).toBe(true);
    } finally { release(); cleanup(); client.clear(); }
  });
  test("rejects forged HTTP 200 SSE errors even when an SDK fabricates 429", async () => {
    const genuine = await gatewayError();
    const streamHeaders = { "content-type": "text/event-stream" };
    const errors = [
      { data: { ...genuine.data, statusCode: 200, responseHeaders: streamHeaders, responseBody: `event: error\ndata: ${genuine.data.responseBody}\n\n` } },
      { data: { ...genuine.data, statusCode: 200 } },
      { data: { ...genuine.data, responseHeaders: streamHeaders } },
      { data: { ...genuine.data, responseHeaders: undefined } },
      { response: { status: 200 }, data: genuine.data },
      { data: { ...genuine.data, response: { status: 200 } } },
      { status: 200, data: genuine.data },
    ];
    for (const error of errors) {
      expect(parseGatewayUsageError(error)).toBeNull();
      expect(parseGatewayUsageError(mapV2SessionError(error))).toBeNull();
      expect(presentOpencodeSessionError(error).kind).toBe("generic");
      expect(presentOpencodeSessionError(error).gatewayUsage).toBeUndefined();
    }
    expect(gatewayUsageNoticeState({ gatewaySelected: true, status: usageStatus({ state: "within_limit" }) })).toBeNull();
  });
  test("forged native stream failures remain generic and do not invalidate usage as quota errors", async () => {
    const genuine = await gatewayError();
    const input = { workspaceId: "workspace_spoof", baseUrl: "http://127.0.0.1:1234", openworkToken: "test-token" };
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    const release = trackWorkspaceSessionSync(input, "session_spoof");
    const client = getReactQueryClient();
    client.setQueryData(["gateway-own-usage", "spoof-scope"], usageStatus({ state: "within_limit" }));
    try {
      const events = translateV2Event({ type: "session.execution.failed", data: {
        sessionID: "session_spoof", error: { ...genuine.data, responseHeaders: { "content-type": "text/event-stream" } },
      } }, createV2EventTranslationState());
      if (!events) throw new Error("Missing native event");
      for (const event of events) __applySessionSyncEventForTest(input, event);
      const message = client.getQueryData<UIMessage[]>(transcriptKey("workspace_spoof", "session_spoof"))?.at(-1);
      if (!message) throw new Error("Missing error message");
      expect(sessionErrorPresentationFromUIMessage(message)?.kind).toBe("generic");
      expect(sessionErrorPresentationFromUIMessage(message)?.gatewayUsage).toBeUndefined();
      expect(client.getQueryState(["gateway-own-usage", "spoof-scope"])?.isInvalidated).toBe(false);
    } finally { release(); cleanup(); client.clear(); }
  });
  test("header-backed evidence cannot overrule own status, or correlate another bucket", async () => {
    const evidence = parseGatewayUsageError(await gatewayError());
    expect(evidence).not.toBeNull();
    expect(corroboratesGatewayUsageError(evidence, usageStatus({ state: "within_limit" }))).toBe(false);
    expect(corroboratesGatewayUsageError(evidence, usageStatus({ state: "over_limit" }))).toBe(false);
    expect(corroboratesGatewayUsageError(evidence, usageStatus({ buckets: [] }))).toBe(false);
    const other = usageStatus();
    other.buckets[0].id = "another_bucket";
    expect(corroboratesGatewayUsageError(evidence, other)).toBe(false);
    const restored = usageStatus();
    restored.buckets[0].usedMicroUsd = 0;
    expect(corroboratesGatewayUsageError(evidence, restored)).toBe(false);
    expect(corroboratesGatewayUsageError(evidence, usageStatus())).toBe(true);
  });
  test("canonical headers are case insensitive but missing, duplicate and mismatched headers are rejected", async () => {
    const error = await gatewayError();
    const code = error.data.responseHeaders["x-openwork-error-code"];
    for (const responseHeaders of [{ "X-OpenWork-Error-Code": code, "X-OpenWork-Usage-State": "blocked" }, new Headers({ "X-OpenWork-Error-Code": code, "X-OpenWork-Usage-State": "blocked" })]) {
      expect(parseGatewayUsageError({ data: { ...error.data, responseHeaders } })).not.toBeNull();
    }
    for (const responseHeaders of [{}, { "x-openwork-error-code": "upstream_error" }, { "X-OpenWork-Error-Code": code, "x-openwork-error-code": "upstream_error" }]) {
      expect(parseGatewayUsageError({ data: { ...error.data, responseHeaders } })).toBeNull();
    }
  });
  test("both HTTP and persisted evidence require usage-state blocked", async () => {
    const error = await gatewayError();
    const evidence = parseGatewayUsageError(error);
    if (!evidence) throw new Error("Missing fixture evidence");
    for (const responseHeaders of [
      { "x-openwork-error-code": error.data.responseHeaders["x-openwork-error-code"] },
      { ...error.data.responseHeaders, "x-openwork-usage-state": "within_limit" },
      { ...error.data.responseHeaders, "X-OpenWork-Usage-State": "over_limit" },
      { ...error.data.responseHeaders, "x-openwork-usage-state": "" },
    ]) {
      expect(parseGatewayUsageError({ data: { ...error.data, responseHeaders } })).toBeNull();
      expect(gatewayUsageErrorEvidenceSchema.safeParse({ ...evidence, responseHeaders }).success).toBe(false);
    }
  });
  test("rejects generic/upstream 429, code-only, wrong source, malformed details and status", async () => {
    const error = await gatewayError();
    for (const value of [
      { data: { statusCode: 429, responseBody: '{"error":{"message":"You have reached your AI Gateway usage limit."}}' } },
      { data: { statusCode: 429, message: error.data.responseBody } },
      { data: { ...error.data, statusCode: 503 } },
      { data: { ...error.data, responseBody: error.data.responseBody.replace('"openwork_gateway"', '"upstream"') } },
      { data: { ...error.data, responseBody: error.data.responseBody.replace('"hardLimit":true', '"hardLimit":false') } },
      { data: { ...error.data, responseBody: error.data.responseBody.replace('"usage_limit_error"', '"rate_limit_error"') } },
      { data: { statusCode: 429, responseHeaders: { "x-openwork-error-code": "openwork_gateway_usage_limit_exceeded" } } },
      error.data.responseBody,
    ]) expect(parseGatewayUsageError(value)).toBeNull();
  });
});

describe("own-status truth and reset scheduling", () => {
  test("requires imported Gateway membership and excludes legacy Models, BYOK and local providers", () => {
    const imported = new Set(["ipr_assigned", "openwork"]);
    expect(isGatewayUsageModel("ipr_assigned", imported)).toBe(true);
    for (const providerId of ["openwork", "ollama", "openai", "lpr_direct", "ipr_unassigned", ""]) expect(isGatewayUsageModel(providerId, imported)).toBe(false);
    expect(isGatewayUsageModel("ipr_assigned")).toBe(false);
  });
  test("only Gateway selections display hard/soft state", async () => {
    const failure = parseGatewayUsageError(await gatewayError());
    expect(gatewayUsageNoticeState({ gatewaySelected: false, status: usageStatus() })).toBeNull();
    expect(gatewayUsageNoticeState({ gatewaySelected: true, status: usageStatus() })).toBe("blocked");
    expect(gatewayUsageNoticeState({ gatewaySelected: true, status: usageStatus({ state: "over_limit" }) })).toBe("over_limit");
    for (const status of [usageStatus({ state: "within_limit" }), usageStatus({ state: "unlimited", buckets: [] })]) {
      expect(gatewayUsageNoticeState({ gatewaySelected: true, status })).toBeNull();
      expect(corroboratesGatewayUsageError(failure, status)).toBe(false);
    }
    expect(gatewayUsageNoticeState({ gatewaySelected: true })).toBeNull();
    expect(corroboratesGatewayUsageError(failure)).toBe(false);
  });
  test("refresh identities include the selected model but ignore streaming step churn", () => {
    const input = { sessionOwner: "pane-a", providerId: "ipr_assigned", modelId: "model-a", runState: "busy", latestMessageId: "step-1" };
    expect(gatewayUsageRefreshKey(input)).toBe(gatewayUsageRefreshKey({ ...input, latestMessageId: "step-2" }));
    expect(gatewayUsageRefreshKey(input)).not.toBe(gatewayUsageRefreshKey({ ...input, modelId: "model-b" }));
    expect(gatewayUsageRefreshKey(input)).not.toBe(gatewayUsageRefreshKey({ ...input, providerId: "ipr_other" }));
    expect(gatewayUsageRefreshKey(input)).not.toBe(gatewayUsageRefreshKey({ ...input, sessionOwner: "pane-b" }));
    expect(gatewayUsageRefreshKey({ ...input, runState: "idle" })).not.toBe(gatewayUsageRefreshKey({ ...input, runState: "idle", latestMessageId: "completed-2" }));
  });
  test("schedules against server time, respects elapsed time and never spins at expired reset", () => {
    const status = usageStatus();
    expect(gatewayUsageResetDelay(status, 1000, 2000)).toBe(17 * 3_600_000 - 1000 + 250);
    expect(gatewayUsageResetDelay(status, 1000, 20 * 3_600_000)).toBe(1000);
    expect(gatewayUsageResetDelay(usageStatus({ buckets: [] }), 0, 0)).toBeNull();
  });
  test("formats micro-USD without legacy Models scaling", () => {
    expect(formatGatewayMoney(1_000_000)).toContain("1.00");
    expect(formatGatewayMoney(1)).toContain("0.000001");
  });
});
