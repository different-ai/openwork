import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTOMATION_FREE_MODEL } from "@openwork/types/automations";
import {
  cloudModelOptions,
  cloudResponsibilityBody,
  describePlacement,
  describeRunOutcome,
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
  assert.deepEqual(parseDenLlmProviders(null), []);
  assert.deepEqual(parseDenLlmProviders({ llmProviders: "nope" }), []);
});

test("cloudModelOptions lists the free starter, OpenWork managed models, then authorized custom models", () => {
  const options = cloudModelOptions(providers);
  assert.equal(options[0]?.id, `${AUTOMATION_FREE_MODEL.providerId}/${AUTOMATION_FREE_MODEL.modelId}`);
  assert.equal(options[0]?.accessKind, "free");
  const kinds = options.map((option) => option.accessKind);
  assert.ok(kinds.indexOf("openwork_managed") < kinds.indexOf("authorized_custom"));
  assert.ok(options.some((option) => option.providerId === "openwork"));
  assert.ok(options.some((option) => option.id === "lpr_anthropic/claude-haiku-4-5" && option.modelName === "Claude Haiku 4.5"));
  assert.equal(cloudModelOptions(providers, { includeFreeStarter: false }).some((option) => option.accessKind === "free"), false);
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
  assert.equal(unauthorized.resolution, "default");
  assert.deepEqual(unauthorized.model, {
    providerId: AUTOMATION_FREE_MODEL.providerId,
    modelId: AUTOMATION_FREE_MODEL.modelId,
    variant: null,
  });

  assert.equal(resolveCloudModel(undefined, providers).resolution, "default");
  assert.equal(resolveCloudModel({ model: "malformed" }, providers).resolution, "default");
});

test("resolveCloudModel falls back to the first authorized option when the free starter is excluded", () => {
  const options = cloudModelOptions(providers, { includeFreeStarter: false });
  const resolved = resolveCloudModel({ model: "openai/gpt-5" }, providers, options);
  assert.equal(resolved.resolution, "default");
  assert.equal(resolved.model.providerId, options[0]?.providerId);
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

test("describePlacement never describes desktop placement as always-on", () => {
  assert.equal(describePlacement("cloud").label, "OpenWork Cloud");
  assert.match(describePlacement("cloud").detail, /cannot read this coworker's local files/);
  assert.equal(describePlacement("desktop").label, "OpenWork desktop");
  assert.match(describePlacement("desktop").detail, /Open Coworker does not run these/);
  assert.equal(describePlacement(undefined).target, "unknown");
});

test("describeRunOutcome surfaces Den's own reason for runs that did not succeed", () => {
  assert.equal(describeRunOutcome(null), "Never");
  assert.equal(describeRunOutcome({ status: "succeeded", error: null }), "Succeeded");
  assert.equal(
    describeRunOutcome({
      status: "skipped",
      error: { code: "runner_unavailable", message: "Missed — no desktop was connected.", retryable: false },
    }),
    "Skipped · Missed — no desktop was connected.",
  );
});
