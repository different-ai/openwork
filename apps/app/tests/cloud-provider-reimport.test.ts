import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  DenOrgLlmProviderConnection,
  DenOrgLlmProviderModel,
} from "../src/app/lib/den";
import type { CloudImportedProvider } from "../src/app/cloud/import-state";
import {
  buildRuntimeProviderPatch,
  getCloudManagedProviderId,
  getProviderModelIds,
  isCloudManagedProviderKey,
  isCloudProviderOutOfSync,
} from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";

const LPR_ID = "lpr_openrouter";

const providerAuthStoreSourcePath = join(
  import.meta.dir,
  "..",
  "src",
  "react-app",
  "domains",
  "connections",
  "provider-auth",
  "store.ts",
);

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
  apiKeys: null,
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

const patchModelKeys = (patch: Record<string, unknown>): string[] => {
  const block = patch[LPR_ID] as { models?: Record<string, unknown> } | null | undefined;
  return block?.models ? Object.keys(block.models).sort() : [];
};

describe("cloud provider runtime patch (re-import diff #2346)", () => {
  test("first import upserts the lpr_* entry with the initial model", () => {
    const provider = makeProvider([makeModel("model-x")], "2024-02-01T00:00:00.000Z");
    const patch = buildRuntimeProviderPatch(provider, LPR_ID);
    expect(Object.keys(patch)).toEqual([LPR_ID]);
    expect(patchModelKeys(patch)).toEqual(["model-x"]);
  });

  test("re-import replaces the entry wholesale (adds and drops models)", () => {
    const updated = makeProvider(
      [makeModel("model-x"), makeModel("model-y")],
      "2024-03-01T00:00:00.000Z",
    );
    expect(patchModelKeys(buildRuntimeProviderPatch(updated, LPR_ID, LPR_ID))).toEqual([
      "model-x",
      "model-y",
    ]);

    const onlyY = makeProvider([makeModel("model-y")], "2024-04-01T00:00:00.000Z");
    expect(patchModelKeys(buildRuntimeProviderPatch(onlyY, LPR_ID, LPR_ID))).toEqual(["model-y"]);
  });

  test("a renamed provider id deletes the predecessor entry", () => {
    const provider = makeProvider([makeModel("model-x")], "2024-03-01T00:00:00.000Z");
    const patch = buildRuntimeProviderPatch(provider, LPR_ID, "lpr_previous");
    expect(patch["lpr_previous"]).toBeNull();
    expect(patchModelKeys(patch)).toEqual(["model-x"]);
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

  test("provider baseline persistence does not refresh the desktop cloud snapshot", () => {
    const source = readFileSync(providerAuthStoreSourcePath, "utf8");
    const persistStart = source.indexOf("const persistImportedCloudProviders = async");
    const persistEnd = source.indexOf("const readProjectConfigFile", persistStart);
    expect(persistStart).toBeGreaterThanOrEqual(0);
    expect(persistEnd).toBeGreaterThan(persistStart);

    const persistSource = source.slice(persistStart, persistEnd);
    expect(persistSource).toContain("const config = await readWorkspaceOpenworkConfigRecord();");
    expect(persistSource).toContain("const cloudImports = readWorkspaceCloudImports(config);");
    expect(persistSource).toContain("const nextConfig = withWorkspaceCloudImports(config");
    expect(persistSource).toContain("const persisted = await writeWorkspaceOpenworkConfigRecord(nextConfig);");
    expect(persistSource).toContain('setStateField("importedCloudProviders", nextProviders);');
    expect(source).not.toContain("refreshDesktop" + "CloudSync");
    expect(source).not.toContain("getResource" + "Snapshot");
  });
});
