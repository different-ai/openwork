import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultProviderLimitLabel, providerLimitLabel } from "./provider-limit-scope";

test("the enabled default scope names the exclusion instead of claiming all providers", () => {
  assert.equal(providerLimitLabel(null, []), "Providers without their own limit");
  assert.equal(providerLimitLabel(undefined, undefined), defaultProviderLimitLabel);
});

test("the default excludes providers with their own policies", () => {
  const retained = [{ id: "saved", name: "Existing provider" }];
  assert.equal(providerLimitLabel(null, retained), defaultProviderLimitLabel);
  assert.equal(providerLimitLabel("saved", retained), "Existing provider");
});

test("an unavailable lookup preserves a saved scope without claiming it was removed", () => {
  assert.equal(providerLimitLabel("saved", undefined), "Saved provider (unverified)");
});

test("absence from the manageable list does not prove deletion", () => {
  assert.equal(providerLimitLabel("saved", []), "Provider not in current list");
});

test("a known saved provider retains its name", () => {
  assert.equal(providerLimitLabel("saved", [{ id: "saved", name: "Existing provider" }]), "Existing provider");
});
