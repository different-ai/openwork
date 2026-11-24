import { describe, expect, test } from "bun:test";
import { GATEWAY_USAGE_LIMIT_ERROR_CODE, gatewayUsageLimitResponse } from "@openwork/types/den/gateway-usage-limits";
import { presentOpencodeSessionError } from "../src/react-app/domains/session/sync/session-error";

const serverTime = "2026-11-19T12:00:00.000Z";
const bucket = {
  id: "bucket_daily", timeframe: "day", usedMicroUsd: 5_000_000, allowanceMicroUsd: 5_000_000,
  resetAt: "2026-11-20T00:00:00.000Z", hardLimit: true, allowRequestReset: true,
} as const;

async function gatewayReply(provider?: { id: string; name: string }) {
  const response = gatewayUsageLimitResponse({ buckets: [bucket as never], serverTime }, provider)!;
  return { headers: Object.fromEntries(response.headers), body: await response.text() };
}

describe("a used-up AI Gateway limit", () => {
  test("engine v1 with the full reply says the limit was reached, not too many requests", async () => {
    const { headers, body } = await gatewayReply();
    const presentation = presentOpencodeSessionError({ name: "APIError", data: { message: "You have reached your AI Gateway usage limit.", statusCode: 429, responseHeaders: headers, responseBody: body } });
    expect(presentation.kind).toBe("gateway-usage-limit");
    expect(presentation.title).toBe("You’ve reached your AI Gateway usage limit");
    expect(presentation.gatewayUsage?.details.exhaustedBuckets[0]?.bucketId).toBe("bucket_daily");
    expect(presentation.recoveryPrompt).toBeNull();
  });

  test("engine v1 without the policy headers is still the limit", async () => {
    const { body } = await gatewayReply();
    const presentation = presentOpencodeSessionError({ name: "APIError", data: { message: "Too many requests", statusCode: 429, responseBody: body } });
    expect(presentation.kind).toBe("gateway-usage-limit");
    expect(presentation.gatewayUsage).toBeUndefined();
  });

  test("engine v2's HTTP 429 text with the gateway body is the limit", async () => {
    const { body } = await gatewayReply();
    const presentation = presentOpencodeSessionError({ name: "UnknownError", data: { message: `Provider request failed with HTTP 429: ${body}` } });
    expect(presentation.kind).toBe("gateway-usage-limit");
    expect(presentation.title).toBe("You’ve reached your AI Gateway usage limit");
  });

  test("engine v2's bare gateway message is the limit", () => {
    const presentation = presentOpencodeSessionError({ name: "UnknownError", data: { message: "You have reached your AI Gateway usage limit." } });
    expect(presentation.kind).toBe("gateway-usage-limit");
    expect(presentation.description).toBe("Wait for your limit to reset, or ask your admin for more.");
  });

  test("a provider limit suggests another provider's model", async () => {
    const { headers, body } = await gatewayReply({ id: "prov_1", name: "Anthropic" });
    for (const error of [
      { name: "APIError", data: { message: "Too many requests", statusCode: 429, responseHeaders: headers, responseBody: body } },
      { name: "UnknownError", data: { message: "You have reached your AI Gateway usage limit for Anthropic. Models from another provider may still be available." } },
    ]) {
      const presentation = presentOpencodeSessionError(error);
      expect(presentation.kind).toBe("gateway-usage-limit");
      expect(presentation.description).toContain("another provider");
    }
  });

  test("an ordinary 429 or the code on another status stays as it was", () => {
    expect(presentOpencodeSessionError({ name: "APIError", data: { message: "Too many requests", statusCode: 429, responseBody: "{}" } }).kind).toBe("rate-limited");
    expect(presentOpencodeSessionError({ name: "APIError", data: { message: "Bad gateway", statusCode: 502, responseBody: GATEWAY_USAGE_LIMIT_ERROR_CODE } }).kind).toBe("provider-unavailable");
  });
});
