import assert from "node:assert/strict";
import { test } from "node:test";
import { bedrockGuardrailSettingsError, bedrockGuardrailSettingsSchema, gatewayProviderSettingsSchema } from "../src/den/inference.js";

test("Bedrock guardrails accept AWS IDs, partition ARNs and published or draft versions", () => {
  for (const guardrailIdentifier of ["a".repeat(64), "abc123", "arn:aws:bedrock:us-east-1:123456789012:guardrail/abc123", "arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:guardrail/abc123"]) {
    for (const guardrailVersion of ["DRAFT", "1", "99999999"]) {
      assert.ok(gatewayProviderSettingsSchema.safeParse({ guardrailIdentifier, guardrailVersion }).success);
    }
  }
  assert.ok(gatewayProviderSettingsSchema.safeParse({}).success);
  assert.ok(gatewayProviderSettingsSchema.safeParse({ guardrailIdentifier: "", guardrailVersion: "" }).success);
});

test("both settings schemas require both fields omitted, both empty, or both valid", () => {
  const schemas = [bedrockGuardrailSettingsSchema, gatewayProviderSettingsSchema];
  for (const schema of schemas) {
    for (const policy of [{}, { guardrailIdentifier: "", guardrailVersion: "" }, { guardrailIdentifier: "abc123", guardrailVersion: "1" }]) {
      assert.equal(schema.safeParse(policy).success, true);
    }
    for (const policy of [{ guardrailIdentifier: "" }, { guardrailVersion: "" }, { guardrailIdentifier: "abc123" }, { guardrailVersion: "1" }, { guardrailIdentifier: "abc123", guardrailVersion: "" }, { guardrailIdentifier: "", guardrailVersion: "1" }]) {
      assert.equal(schema.safeParse(policy).success, false);
    }
  }
});

test("guardrails reject malformed or partial policy and other providers", () => {
  for (const guardrailIdentifier of ["ABC123", "a".repeat(65), "abc/123", "arn:aws:s3:us-east-1:123456789012:guardrail/abc123", "arn:aws:bedrock:us-east-1:123:guardrail/abc123"]) {
    assert.equal(gatewayProviderSettingsSchema.safeParse({ guardrailIdentifier, guardrailVersion: "1" }).success, false);
  }
  for (const guardrailVersion of ["0", "01", "100000000", "draft", "1.0", "-1"]) {
    assert.equal(gatewayProviderSettingsSchema.safeParse({ guardrailIdentifier: "abc123", guardrailVersion }).success, false);
  }
  for (const policy of [{ guardrailIdentifier: "abc123" }, { guardrailVersion: "DRAFT" }, { guardrailIdentifier: "", guardrailVersion: "1" }]) {
    assert.equal(gatewayProviderSettingsSchema.safeParse(policy).success, false);
  }
  assert.ok(bedrockGuardrailSettingsError("openai", { guardrailIdentifier: "abc123", guardrailVersion: "1" }));
  assert.ok(bedrockGuardrailSettingsError("amazon-bedrock-mantle", { guardrailIdentifier: "abc123", guardrailVersion: "1" }));
  assert.equal(bedrockGuardrailSettingsError("amazon-bedrock", { guardrailIdentifier: "abc123", guardrailVersion: "1" }), null);
});
