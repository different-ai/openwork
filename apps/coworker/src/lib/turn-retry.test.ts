import assert from "node:assert/strict";
import { test } from "node:test";
import { RETRY_DELAYS_MS, classifyFailure, describeWait, retryDelayMs } from "./turn-retry.ts";

test("network trouble, a busy or rate-limited provider, a 5xx, and a restarting AI service are transient", () => {
  for (const raw of [
    "ECONNRESET",
    "fetch failed",
    "socket hang up",
    "APIError: 429 Too Many Requests",
    "Rate limit exceeded, try again later",
    "APIError: 503 Service Unavailable",
    "502 Bad Gateway",
    "The model is overloaded",
    "request timed out",
    "OpenWork returned 503 for GET /session",
    "Scout's workspace is not answering right now.",
  ]) {
    assert.equal(classifyFailure(raw), "transient", raw);
  }
});

test("a model that cannot do the job, a refused account, a denied tool, or a stop are hard", () => {
  for (const raw of [
    'APIError: No endpoints found that support tool use. Try disabling "bash".',
    "This model does not support tool calling",
    'The saved model "missing/one" is not available: provider "missing" is not connected on this Mac.',
    "No connected AI model can use tools. Connect an AI provider in OpenWork, or choose an AI model in Coworker settings.",
    "ProviderError: 401 Unauthorized",
    "403 Forbidden",
    "Invalid API key",
    "Insufficient credits",
    "Free usage exceeded, subscribe to Go",
    "APIError · FreeUsageLimitError: Error from provider (Console): Rate limit exceeded. Please try again later.",
    "Tool execution failed: permission denied",
    "MessageAbortedError: aborted",
    "The model stopped before producing a response.",
    "prompt is too long: 210000 tokens > 200000 maximum context",
    "Something unexpected happened",
  ]) {
    assert.equal(classifyFailure(raw), "hard", raw);
  }
});

test("the engine's own retryable verdict decides when the words say nothing, and a hard sign always wins", () => {
  assert.equal(classifyFailure("Something unexpected happened", true), "transient");
  assert.equal(classifyFailure("Something unexpected happened", false), "hard");
  assert.equal(classifyFailure("ECONNRESET", false), "hard");
  assert.equal(classifyFailure("429 Free usage exceeded, subscribe to Go", true), "hard");
});

test("three automatic attempts wait 2 s, 6 s, and 15 s, then the budget is spent", () => {
  assert.deepEqual([...RETRY_DELAYS_MS], [2_000, 6_000, 15_000]);
  assert.equal(retryDelayMs(1), 2_000);
  assert.equal(retryDelayMs(2), 6_000);
  assert.equal(retryDelayMs(3), 15_000);
  assert.equal(retryDelayMs(4), null);
  assert.equal(retryDelayMs(0), null);
  assert.equal(retryDelayMs(1.5), null);
});

test("a wait reads the way a person would say it", () => {
  assert.equal(describeWait(2_000), "2 s");
  assert.equal(describeWait(5_400), "6 s");
  assert.equal(describeWait(400), "1 s");
  assert.equal(describeWait(60_000), "1 min");
  assert.equal(describeWait(9 * 3_600_000), "9 hr");
});
