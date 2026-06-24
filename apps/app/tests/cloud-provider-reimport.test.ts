import { describe, expect, test } from "bun:test";
import { parse } from "jsonc-parser";

import type {
  DenOrgLlmProviderConnection,
  DenOrgLlmProviderModel,
} from "../src/app/lib/den";
import type { CloudImportedProvider } from "../src/app/cloud/import-state";
import {
  formatConfigWithCloudProvider,
  getCloudManagedProviderId,
  getProviderModelIds,
  isCloudManagedProviderKey,
  isCloudProviderOutOfSync,
} from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";

const LPR_ID = "lpr_openrouter";

const makeModel = (id: string, name = id): DenOrgLlmProviderModel => ({
  id,
  name,
  config: {},
  createdAt: null,
});

const makeProvider = (
  models: DenOrgLlmProviderModel[],
  updatedAt: string,
): DenOrgLlmProviderConnection => ({
  id: LPR_ID,
  source: "custom",
  providerId: "openrouter",
  name: "OpenRouter",
  providerConfig: {
    id: "openrouter",
    name: "OpenRouter",
    npm: "@ai-sdk/openai-compatible",
    env: ["OPENROUTER_API_KEY"],
    api: "https://openrouter.ai/api/v1",
    models: {},
  },
  hasApiKey: true,
  models,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt,
  apiKey: "sk-test",
});

const importedFrom = (
  provider: DenOrgLlmProviderConnection,
): CloudImportedProvider => ({
  cloudProviderId: provider.id,
  providerId: getCloudManagedProviderId(provider),
  sourceProviderId: provider.providerId,
  name: provider.name,
  source: provider.source,
  updatedAt: provider.updatedAt,
  modelIds: getProviderModelIds(provider),
  importedAt: Date.now(),
});

const providerModelKeys = (raw: string): string[] => {
  const parsed = parse(raw) as
    | { provider?: Record<string, { models?: Record<string, unknown> }> }
    | undefined;
  const block = parsed?.provider?.[LPR_ID];
  return block?.models ? Object.keys(block.models).sort() : [];
};

describe("cloud provider re-import diff (#2346)", () => {
  test("first import writes the lpr_* block with the initial model", () => {
    const provider = makeProvider([makeModel("model-x")], "2024-02-01T00:00:00.000Z");
    const config = formatConfigWithCloudProvider("", provider, LPR_ID, {
      disabledProviders: [],
    });
    expect(providerModelKeys(config)).toEqual(["model-x"]);
  });

  test("re-import adds a newly added model (X then X + Y)", () => {
    const first = makeProvider([makeModel("model-x")], "2024-02-01T00:00:00.000Z");
    const initial = formatConfigWithCloudProvider("", first, LPR_ID, {
      disabledProviders: [],
    });
    expect(providerModelKeys(initial)).toEqual(["model-x"]);

    const updated = makeProvider(
      [makeModel("model-x"), makeModel("model-y")],
      "2024-03-01T00:00:00.000Z",
    );
    const reimported = formatConfigWithCloudProvider(initial, updated, LPR_ID, {
      previousProviderId: LPR_ID,
      disabledProviders: [],
    });
    expect(providerModelKeys(reimported)).toEqual(["model-x", "model-y"]);
  });

  test("re-import drops a removed model (X + Y then only Y)", () => {
    const both = makeProvider(
      [makeModel("model-x"), makeModel("model-y")],
      "2024-03-01T00:00:00.000Z",
    );
    const initial = formatConfigWithCloudProvider("", both, LPR_ID, {
      disabledProviders: [],
    });
    expect(providerModelKeys(initial)).toEqual(["model-x", "model-y"]);

    const onlyY = makeProvider([makeModel("model-y")], "2024-04-01T00:00:00.000Z");
    const reimported = formatConfigWithCloudProvider(initial, onlyY, LPR_ID, {
      previousProviderId: LPR_ID,
      disabledProviders: [],
    });
    expect(providerModelKeys(reimported)).toEqual(["model-y"]);
  });

  test("re-import preserves unrelated provider blocks and config keys", () => {
    const base = [
      "{",
      '  "$schema": "https://opencode.ai/config.json",',
      '  "provider": {',
      '    "anthropic": { "models": { "claude": { "id": "claude", "name": "Claude" } } }',
      "  }",
      "}",
      "",
    ].join("\n");
    const provider = makeProvider(
      [makeModel("model-x"), makeModel("model-y")],
      "2024-03-01T00:00:00.000Z",
    );
    const result = formatConfigWithCloudProvider(base, provider, LPR_ID, {
      disabledProviders: [],
    });
    const parsed = parse(result) as {
      provider?: Record<string, unknown>;
      $schema?: string;
    };
    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
    expect(Object.keys(parsed.provider ?? {}).sort()).toEqual([
      "anthropic",
      LPR_ID,
    ]);
    expect(providerModelKeys(result)).toEqual(["model-x", "model-y"]);
  });

  test("cloud-managed key predicate guards re-import vs manual clobber", () => {
    expect(isCloudManagedProviderKey(LPR_ID)).toBe(true);
    expect(isCloudManagedProviderKey("lpr_anything")).toBe(true);
    expect(isCloudManagedProviderKey("openwork")).toBe(true);
    expect(isCloudManagedProviderKey("openai")).toBe(false);
    expect(isCloudManagedProviderKey("anthropic")).toBe(false);
  });

  test("out-of-sync detection flags a changed Den model list", () => {
    const first = makeProvider([makeModel("model-x")], "2024-02-01T00:00:00.000Z");
    const baseline = importedFrom(first);

    // Same payload -> in sync.
    expect(isCloudProviderOutOfSync(first, baseline)).toBe(false);

    // Den adds a model -> out of sync (drives the Sync/Import action).
    const updated = makeProvider(
      [makeModel("model-x"), makeModel("model-y")],
      "2024-03-01T00:00:00.000Z",
    );
    expect(isCloudProviderOutOfSync(updated, baseline)).toBe(true);

    // After re-import the baseline advances -> in sync again.
    expect(isCloudProviderOutOfSync(updated, importedFrom(updated))).toBe(false);
  });
});
