import assert from "node:assert/strict";
import { test } from "node:test";
import { describeConversationError, describeTurnFailure, failureText } from "./turn-failure.ts";

test("conversation errors give a calm next step and keep the exact cause in details", () => {
  const timeout = describeConversationError("The operation was aborted due to timeout");
  assert.equal(timeout.headline, "This is taking longer than expected");
  assert.match(timeout.detail, /before sending the message again/);
  assert.equal(timeout.technical, "The operation was aborted due to timeout");

  const service = describeConversationError("The native AI service answered with HTTP 500.");
  assert.equal(service.headline, "The AI service had a problem");
  assert.equal(service.technical, "The native AI service answered with HTTP 500.");

  const model = describeConversationError('The saved model "anthropic/claude-opus" is not available.');
  assert.equal(model.headline, "Choose an available AI model");
});

test("provider rejections point at the model or account; other failures stay neutral", () => {
  const rejected = describeTurnFailure("ProviderError: 401 Unauthorized", "Scout");
  assert.equal(rejected.modelRelated, true);
  assert.equal(rejected.technical, "ProviderError: 401 Unauthorized");

  const stopped = describeTurnFailure("The model stopped before producing a response.", "Scout");
  assert.equal(stopped.modelRelated, false);
  assert.equal(stopped.transient, false);

  const other = describeTurnFailure("Tool execution failed: permission denied", "Scout");
  assert.equal(other.technical, "Tool execution failed: permission denied");
  assert.equal(other.transient, false);
});

test("a dropped connection, a busy provider, or a 5xx is transient: the coworker couldn't reach the model", () => {
  for (const raw of ["ECONNRESET", "APIError: 503 Service Unavailable", "APIError: 429 Too Many Requests"]) {
    const failure = describeTurnFailure(raw, "Scout");
    assert.equal(failure.transient, true, raw);
    assert.equal(failure.modelRelated, true, raw);
    assert.equal(failure.technical, raw);
  }
  // The engine's own verdict counts when the words say nothing.
  assert.equal(describeTurnFailure("Something went wrong", "Scout", true).transient, true);
  assert.equal(describeTurnFailure("Something went wrong", "Scout", false).transient, false);
  // A hard sign wins over a transient one: the free tier being used up is not a moment to wait out.
  assert.equal(describeTurnFailure("APIError: 429 Free usage exceeded, subscribe to Go", "Scout", true).transient, false);
});

test("the provider error type distinguishes exhausted free usage from a transient rate limit", () => {
  const failure = describeTurnFailure(failureText({ name: "APIError", message: "Rate limit exceeded.", providerError: "FreeUsageLimitError" }), "Scout");
  assert.equal(failure.freeModelLimit, true);
  assert.equal(failure.transient, false);
  assert.equal(describeTurnFailure("APIError: 429 rate limited", "Scout").freeModelLimit, false);
});
