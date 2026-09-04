import assert from "node:assert/strict";
import { test } from "node:test";
import { describeTurnFailure, failureText } from "./turn-failure.ts";

test("a tool-support refusal becomes one plain headline with the raw text kept as technical detail", () => {
  const raw = 'APIError: No endpoints found that support tool use. Try disabling "bash".';
  const failure = describeTurnFailure(raw, "Nova");
  assert.equal(failure.headline, "Nova's AI model cannot use the tools enabled for this coworker.");
  assert.match(failure.detail, /supports tools/);
  assert.equal(failure.technical, raw);
  assert.equal(failure.modelRelated, true);
});

test("an unavailable saved model keeps its exact id visible in the detail", () => {
  const raw = 'The saved model "missing-provider/missing-model" is not available: provider "missing-provider" is not connected on this Mac.';
  const failure = describeTurnFailure(raw, "Editor");
  assert.equal(failure.headline, "Editor's AI model is not available.");
  assert.equal(failure.detail, raw);
  assert.equal(failure.technical, "");
  assert.equal(failure.modelRelated, true);
});

test("provider rejections point at the model or account; other failures stay neutral", () => {
  const rejected = describeTurnFailure("ProviderError: 401 Unauthorized", "Scout");
  assert.equal(rejected.headline, "Scout's AI model could not answer.");
  assert.equal(rejected.modelRelated, true);
  assert.equal(rejected.technical, "ProviderError: 401 Unauthorized");

  const stopped = describeTurnFailure("The model stopped before producing a response.", "Scout");
  assert.equal(stopped.headline, "Scout stopped before replying.");
  assert.equal(stopped.modelRelated, false);
  assert.equal(stopped.transient, false);

  const other = describeTurnFailure("Tool execution failed: permission denied", "Scout");
  assert.equal(other.headline, "Scout could not reply.");
  assert.equal(other.detail, "");
  assert.equal(other.technical, "Tool execution failed: permission denied");
  assert.equal(other.transient, false);
});

test("a dropped connection, a busy provider, or a 5xx is transient: the coworker couldn't reach the model", () => {
  for (const raw of ["ECONNRESET", "APIError: 503 Service Unavailable", "APIError: 429 Too Many Requests", "fetch failed", "OpenWork returned 502 for POST /session"]) {
    const failure = describeTurnFailure(raw, "Scout");
    assert.equal(failure.headline, "Scout couldn't reach the AI model.", raw);
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

test("a workspace with no tool-capable model gets a plain headline that points at providers and settings", () => {
  const failure = describeTurnFailure(
    "No connected AI model can use tools. Connect an AI provider in OpenWork, or choose an AI model in Coworker settings.",
    "Nova",
  );
  assert.equal(failure.headline, "No connected AI model can use tools.");
  assert.match(failure.detail, /Coworker settings/);
  assert.equal(failure.technical, "");
  assert.equal(failure.modelRelated, true);
});

test("the free model's shared limit is named as such, however the engine says it, with the person's own provider as the way out", () => {
  for (const raw of [
    "Free usage exceeded, subscribe to Go",
    "APIError · FreeUsageLimitError: Error from provider (Console): Rate limit exceeded. Please try again later.",
    "Free usage exceeded, subscribe to Go (free_tier_limit)",
  ]) {
    const failure = describeTurnFailure(raw, "Scout");
    assert.equal(failure.headline, "The free model is busy right now.", raw);
    assert.equal(failure.detail, "Too many people are using the free model at once. Wait a few minutes and try again, or connect your own AI provider so Scout can keep working.");
    assert.equal(failure.technical, raw);
    assert.equal(failure.modelRelated, true);
    assert.equal(failure.transient, false);
    assert.equal(failure.freeModelLimit, true);
    // The engine's remedy copy stays in the technical fold, never in what the person reads first.
    assert.doesNotMatch(`${failure.headline} ${failure.detail}`, /subscribe|Go\b/);
  }
  // An ordinary rate limit is still the provider not answering, not the free model's limit.
  const ordinary = describeTurnFailure("APIError: 429 rate limited", "Scout");
  assert.equal(ordinary.freeModelLimit, false);
  assert.equal(ordinary.headline, "Scout couldn't reach the AI model.");
});

test("the raw failure line names the provider's own error type beside the engine's, and not twice", () => {
  assert.equal(failureText({ name: "APIError", message: "Rate limit exceeded.", providerError: "FreeUsageLimitError" }), "APIError · FreeUsageLimitError: Rate limit exceeded.");
  assert.equal(failureText({ name: "APIError", message: "503 overloaded", providerError: null }), "APIError: 503 overloaded");
  assert.equal(failureText({ name: "ProviderAuthError", message: "Reconnect.", providerError: "ProviderAuthError" }), "ProviderAuthError: Reconnect.");
  assert.equal(describeTurnFailure(failureText({ name: "APIError", message: "Rate limit exceeded.", providerError: "FreeUsageLimitError" }), "Scout").freeModelLimit, true);
});
