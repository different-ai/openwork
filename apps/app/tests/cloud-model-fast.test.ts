import { describe, expect, spyOn, test } from "bun:test";
import { CATALOG_FAST_VARIANT, CLOUD_MODEL_CONFIG_VERSION, FAST_DEFAULT_VARIANT, catalogFastVariants, fastVariantId, nativeModelVariants, materializeLegacyFastProviders } from "@openwork/types/cloud-model-fast";
import { buildCloudProviderConfig, isCloudProviderOutOfSync } from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";
import { readWorkspaceCloudImports } from "../src/app/cloud/import-state";
import type { DenOrgLlmProviderConnection } from "../src/app/lib/den";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { getModelBehaviorControls } from "../src/app/lib/model-behavior";

const fast = { provider: { body: { service_tier: "priority" } }, cost: { input: 10, output: 60 } };
const config = { experimental: { modes: { fast, pro: { provider: { body: { model: "unverified" } } } } },
  variants: { high: { reasoningEffort: "high" }, CustomExact: { reasoningEffort: "low", textVerbosity: "high" },
    default: { reasoningEffort: "medium" }, hidden: { disabled: true, reasoningEffort: "low" } } };
const provider: DenOrgLlmProviderConnection = {
  id: "lpr_synthetic", providerId: "openai", name: "Synthetic", source: "custom",
  providerConfig: { npm: "@ai-sdk/openai" }, hasApiKey: true, apiKey: "synthetic", apiKeys: null,
  createdAt: null, updatedAt: null, models: [{ id: "model", name: "Model", config, createdAt: null }],
};

describe("catalog Fast runtime gate", () => {
  test("realistic Astra reasoning_options stays disabled until a verified engine materializes it", () => {
    const efforts = ["low", "medium", "high", "xhigh", "max"];
    const raw = { reasoning: true, reasoning_options: [{ type: "effort", values: efforts }],
      cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
      experimental: { modes: { fast: { provider: { body: { service_tier: "priority" } },
        cost: { input: 20, output: 100, cache_read: 2, cache_write: 25 } } } } };
    const serialized = buildCloudProviderConfig({ ...provider, models: [{ id: "gpt-6-astra", name: "Synthetic Astra", config: raw, createdAt: null }] })
      .models?.["gpt-6-astra"];
    expect(serialized?.variants).toEqual({ [CATALOG_FAST_VARIANT]: { disabled: true, openworkNativeFast: 1, reasoningEfforts: efforts } });
    expect(nativeModelVariants(serialized?.variants, "@opencode-ai/ai/providers/openai-compatible")).toEqual([]);
    const native = nativeModelVariants(serialized?.variants, "@opencode-ai/ai/providers/openai");
    expect(native.map((variant) => variant.id)).toEqual([...efforts, FAST_DEFAULT_VARIANT, ...efforts.map(fastVariantId)]);
    for (const effort of efforts) {
      expect(native.find((variant) => variant.id === effort)?.settings).toEqual({ providerOptions: { reasoningEffort: effort } });
      expect(native.find((variant) => variant.id === fastVariantId(effort))?.settings)
        .toEqual({ providerOptions: { reasoningEffort: effort, serviceTier: "priority" } });
    }
    const choices = [{ value: null }, ...native.map(({ id }) => ({ value: id }))];
    expect(getModelBehaviorControls(choices, "high").toggleValue).toBe(fastVariantId("high"));
    expect(getModelBehaviorControls(choices, fastVariantId("low")).toggleValue).toBe("low");
    expect(native.find((variant) => variant.id === FAST_DEFAULT_VARIANT)?.settings).toEqual({ providerOptions: { serviceTier: "priority" } });
    expect(raw).not.toHaveProperty("variants");
  });

  test("pinned v1 materialization preserves custom and disabled variants without mutating imports", () => {
    const serialized = buildCloudProviderConfig(provider);
    const providers = { lpr_synthetic: { ...serialized }, untouched: { npm: "@ai-sdk/openai-compatible", models: {} } };
    const result = materializeLegacyFastProviders(providers);
    expect(result).toMatchObject({ lpr_synthetic: { models: { model: { variants: {
      ...config.variants,
      [fastVariantId("CustomExact")]: { reasoningEffort: "low", textVerbosity: "high", serviceTier: "priority" },
      [FAST_DEFAULT_VARIANT]: { serviceTier: "priority" },
    } } } } });
    expect(JSON.stringify(result)).not.toContain(CATALOG_FAST_VARIANT);
    expect(JSON.stringify(result)).not.toContain(fastVariantId("hidden"));
    expect(serialized.models?.model.variants?.[CATALOG_FAST_VARIANT]).toEqual({ disabled: true, openworkNativeFast: 1 });
    expect(result.untouched).toBe(providers.untouched);
    expect(materializeLegacyFastProviders(result)).toEqual(result);
  });

  test("advertised efforts fill gaps without overriding custom variants or resurrecting disabled ones", () => {
    const serialized = catalogFastVariants({ ...config,
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      variants: { ...config.variants, high: { reasoningEffort: "low", textVerbosity: "high" }, low: { disabled: true } },
    }, "@ai-sdk/openai");
    const native = nativeModelVariants(serialized, "@opencode-ai/ai/providers/openai");
    expect(native.filter((entry) => entry.id === "high")).toHaveLength(1);
    expect(native.find((entry) => entry.id === fastVariantId("high"))?.settings)
      .toEqual({ providerOptions: { reasoningEffort: "low", textVerbosity: "high", serviceTier: "priority" } });
    expect(native.map((entry) => entry.id)).not.toContain("low");
    expect(native.map((entry) => entry.id)).not.toContain(fastVariantId("low"));
    expect(native.find((entry) => entry.id === "medium")?.settings).toEqual({ providerOptions: { reasoningEffort: "medium" } });
    expect(native.find((entry) => entry.id === "default")?.settings).toEqual({ providerOptions: { reasoningEffort: "medium" } });
    expect(native.find((entry) => entry.id === FAST_DEFAULT_VARIANT)?.settings).toEqual({ providerOptions: { serviceTier: "priority" } });
  });

  test("stores only disabled metadata; native combines it with exact custom variants and Default", () => {
    const serialized = buildCloudProviderConfig(provider).models?.model;
    expect(serialized?.experimental).toBeUndefined();
    expect(serialized?.variants?.[CATALOG_FAST_VARIANT]).toEqual({ disabled: true, openworkNativeFast: 1 });
    expect(config.variants).not.toHaveProperty(CATALOG_FAST_VARIANT);
    const variants = nativeModelVariants(serialized?.variants, "@opencode-ai/ai/providers/openai");
    expect(variants.map((entry) => entry.id)).toEqual([
      "high", "CustomExact", "default", FAST_DEFAULT_VARIANT,
      fastVariantId("high"), fastVariantId("CustomExact"), fastVariantId("default"),
    ]);
    expect(variants.find((entry) => entry.id === fastVariantId("CustomExact"))?.settings).toEqual({
      providerOptions: { reasoningEffort: "low", textVerbosity: "high", serviceTier: "priority" },
    });
    expect(variants.find((entry) => entry.id === FAST_DEFAULT_VARIANT)?.settings).toEqual({ providerOptions: { serviceTier: "priority" } });
    expect(JSON.stringify(variants)).not.toContain("openworkNativeFast");
    expect(nativeModelVariants(serialized?.variants, "@opencode-ai/ai/providers/openai-compatible").map((entry) => entry.id))
      .toEqual(["high", "CustomExact", "default"]);
  });

  test("does not synthesize unsupported adapters, modes, body overrides, or colliding IDs", () => {
    for (const npm of [undefined, "@ai-sdk/openai-compatible", "@ai-sdk/anthropic", "@openrouter/ai-sdk-provider"]) {
      expect(catalogFastVariants(config, npm)).toBeUndefined();
    }
    for (const mode of [true, {}, { provider: { body: { service_tier: "flex" } } },
      { provider: { body: { service_tier: "priority", model: "other" } } },
      { ...fast, provider: { ...fast.provider, headers: { test: "value" } } }]) {
      expect(catalogFastVariants({ experimental: { modes: { fast: mode } } }, "@ai-sdk/openai")).toBeUndefined();
    }
    for (const id of [CATALOG_FAST_VARIANT, FAST_DEFAULT_VARIANT]) {
      expect(catalogFastVariants({ ...config, variants: { [id]: { reasoningEffort: "high" } } }, "@ai-sdk/openai")).toBeUndefined();
    }
    expect(catalogFastVariants({ ...config, provider: { npm: "@ai-sdk/anthropic" } }, "@ai-sdk/openai")).toBeUndefined();
    expect(catalogFastVariants({ experimental: { modes: { pro: fast } } }, "@ai-sdk/openai")).toBeUndefined();
  });

  test("reconciles a pre-serializer import once even when IDs and updatedAt have not changed", () => {
    const imported = { cloudProviderId: provider.id, providerId: provider.id, sourceProviderId: provider.providerId,
      name: provider.name, source: provider.source, updatedAt: provider.updatedAt, modelIds: ["model"], importedAt: 1 };
    expect(isCloudProviderOutOfSync(provider, imported)).toBe(true);
    expect(isCloudProviderOutOfSync(provider, { ...imported, modelConfigVersion: 1 })).toBe(true);
    const restored = readWorkspaceCloudImports({ cloudImports: { providers: {
      [provider.id]: { ...imported, modelConfigVersion: CLOUD_MODEL_CONFIG_VERSION },
    } } }).providers[provider.id];
    expect(isCloudProviderOutOfSync(provider, restored)).toBe(false);
  });

  test("server-authoritative sync status keeps the serializer version instead of reporting permanent drift", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ hasSession: true, lastRun: null, providers: [{
      cloudProviderId: provider.id, providerId: provider.id, sourceProviderId: provider.providerId,
      name: provider.name, source: provider.source, updatedAt: null, modelIds: ["model"], importedAt: 1,
      modelConfigVersion: CLOUD_MODEL_CONFIG_VERSION,
    }] }));
    try {
      const client = createOpenworkServerClient({ baseUrl: "http://synthetic.test", token: "synthetic" });
      const status = await client.getCloudProviderSyncStatus();
      expect(status.providers[0].modelConfigVersion).toBe(CLOUD_MODEL_CONFIG_VERSION);
      expect(isCloudProviderOutOfSync(provider, status.providers[0])).toBe(false);
    } finally { fetchSpy.mockRestore(); }
  });
});
