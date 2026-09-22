import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTOMATION_FREE_MODEL } from "@openwork/types/automations";
import {
  cloudModelOptions,
  cloudResponsibilityBody,
  parseDenLlmProviders,
  resolveCloudModel,
} from "./cloud-responsibilities.ts";

const providers = parseDenLlmProviders({
  llmProviders: [
    {
      id: "lpr_anthropic",
      source: "custom",
      providerId: "anthropic",
      name: "Anthropic (org key)",
      models: [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }, { id: "claude-sonnet-4-5" }],
    },
    { id: "lpr_openwork", source: "openwork", providerId: "openwork", name: "OpenWork Models", models: [] },
    { id: "broken", source: "custom" },
    "not an object",
  ],
});

test("parseDenLlmProviders keeps only well-formed member-scoped providers", () => {
  assert.deepEqual(
    providers.map((provider) => provider.id),
    ["lpr_anthropic", "lpr_openwork"],
  );
  assert.equal(providers[0]?.models[1]?.name, "claude-sonnet-4-5");
  assert.throws(() => parseDenLlmProviders(null), /unreadable model inventory/);
  assert.throws(() => parseDenLlmProviders({ llmProviders: "nope" }), /unreadable model inventory/);
  assert.deepEqual(parseDenLlmProviders({ llmProviders: [] }), []);
});

test("resolveCloudModel maps a local engine preference onto the organization's authorized record", () => {
  const mapped = resolveCloudModel({ model: "anthropic/claude-haiku-4-5", modelVariant: "high" }, providers);
  assert.deepEqual(mapped, {
    model: { providerId: "lpr_anthropic", modelId: "claude-haiku-4-5", variant: "high" },
    resolution: "mapped",
  });

  const exact = resolveCloudModel({ model: "lpr_anthropic/claude-sonnet-4-5" }, providers);
  assert.equal(exact.resolution, "exact");
  assert.equal(exact.model.variant, null);

  const unauthorized = resolveCloudModel({ model: "openai/gpt-5" }, providers);
  assert.equal(unauthorized.resolution, "unavailable");
  assert.deepEqual(unauthorized.model, {
    providerId: "openai",
    modelId: "gpt-5",
    variant: null,
  });

  assert.equal(resolveCloudModel(undefined, providers).resolution, "default");
  assert.equal(resolveCloudModel({ model: "malformed" }, providers).resolution, "unavailable");
});

test("only an absent preference defaults, and an empty catalog never invents a free option", () => {
  const options = cloudModelOptions(providers, { includeFreeStarter: false });
  const resolved = resolveCloudModel(undefined, providers, options);
  assert.equal(resolved.resolution, "default");
  assert.equal(resolved.model.providerId, options[0]?.providerId);
  assert.equal(resolveCloudModel(undefined, [], []).resolution, "unavailable");
  assert.equal(resolveCloudModel(undefined, []).model.modelId, AUTOMATION_FREE_MODEL.modelId);
});

test("provider merge preserves legacy and managed choices, deduplicates ids, and excludes Gateway rows", () => {
  const legacy = { id: "lpr_legacy", source: "models_dev", providerId: "openai", models: [{ id: "gpt-5" }] };
  const mixed = parseDenLlmProviders({ llmProviders: [
    ...providers, legacy, legacy,
    { id: "ipr_ready", source: "openwork_gateway", providerId: "anthropic", models: [{ id: "gwm_ready" }] },
    { id: "ipr_wrong_source", source: "custom", providerId: "anthropic", models: [{ id: "gwm_ready" }] },
  ] });
  const options = cloudModelOptions(mixed);
  assert.ok(options.some((option) => option.providerId === "openwork"));
  assert.ok(options.some((option) => option.id === "lpr_anthropic/claude-haiku-4-5"));
  assert.equal(options.filter((option) => option.id === "lpr_legacy/gpt-5").length, 1);
  assert.equal(options.some((option) => option.providerId.startsWith("ipr_")), false);
});

test("local mapping cannot restore a hidden choice or arbitrarily pick between provider records", () => {
  const preference = { model: "anthropic/claude-haiku-4-5" };
  assert.equal(resolveCloudModel(preference, providers, []).resolution, "unavailable");
  const duplicate = { ...providers[0]!, id: "lpr_second" };
  assert.equal(resolveCloudModel(preference, [...providers, duplicate]).resolution, "unavailable");
});

test("Gateway preference retains its exact identity instead of falling back or mapping by upstream", () => {
  const resolved = resolveCloudModel({ model: "ipr_ready/gwm_ready", modelVariant: "high" }, providers);
  assert.deepEqual(resolved, {
    model: { providerId: "ipr_ready", modelId: "gwm_ready", variant: "high" },
    resolution: "unavailable",
  });
  assert.throws(() => cloudResponsibilityBody({
    name: "Digest", instructions: "Summarize", schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
    model: resolved.model,
  }), /Gateway models are not supported/);
});

test("manual exact choice preserves provider, slash-containing model id, and variant in the Cloud body", () => {
  const model = { providerId: "lpr_manual", modelId: "vendor/model", variant: "high" };
  const manual = parseDenLlmProviders({ llmProviders: [{
    id: model.providerId, source: "custom", providerId: "openai", models: [{ id: model.modelId }],
  }] });
  const resolved = resolveCloudModel({ model: "lpr_manual/vendor/model", modelVariant: "high" }, manual);
  assert.equal(resolved.resolution, "exact");
  assert.deepEqual(cloudResponsibilityBody({
    name: "Digest", instructions: "Summarize", schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
    model: resolved.model,
  }).action.model, model);
});

test("cloudResponsibilityBody is the exact Cloud creation shape Den fixes to cloud placement", () => {
  const body = cloudResponsibilityBody({
    name: "  Daily digest ",
    instructions: " Summarize the day. ",
    schedule: { kind: "daily", timezone: "Europe/Berlin", hour: 9, minute: 0 },
    model: { providerId: "lpr_anthropic", modelId: "claude-haiku-4-5", variant: "  " },
  });
  assert.deepEqual(body, {
    name: "Daily digest",
    schedule: { kind: "daily", timezone: "Europe/Berlin", hour: 9, minute: 0 },
    action: {
      kind: "agent",
      instructions: "Summarize the day.",
      model: { providerId: "lpr_anthropic", modelId: "claude-haiku-4-5", variant: null },
    },
  });
  assert.equal("instructions" in body, false, "legacy desktop-placement shape must not be sent");
  assert.equal("workspaceId" in body, false);
});
