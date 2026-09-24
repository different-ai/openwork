import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ModelOption } from "../src/app/types";
import { buildModelCatalog, resolveRetainedSelection, runtimeModelOptions, withAutoActionState, withoutBlockedSelection, type ModelCatalogInput } from "../src/react-app/domains/models/catalog";
import { AUTO_MODEL_ID, AUTO_PROVIDER_ID } from "../src/react-app/domains/models/model-catalog";
import { pendingGatewayModelOptions } from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";

// Provider list shaped like the engine's real response: connected ids plus full model records with costs.
const cost = (input: number, output: number) => ({ input, output, cache: { read: 0, write: 0 } });
const model = (id: string, name: string, pricing = cost(3, 15)) => ({ id, name, cost: pricing, limit: { context: 200_000, output: 8_192 }, options: {} });
function providerList(connected: string[], zenKey = false) {
  const all = [
    { id: "opencode", name: "OpenCode Zen", source: "custom", env: [], models: {
      "big-pickle": model("big-pickle", "Big Pickle", cost(0, 0)),
      // Paid Zen models only appear once a Zen key is pasted.
      ...(zenKey ? { "claude-sonnet-4-6": model("claude-sonnet-4-6", "Claude Sonnet 4.6") } : {}),
    } },
    { id: AUTO_PROVIDER_ID, name: "OpenWork Models (Free)", source: "config", env: [], models: { [AUTO_MODEL_ID]: model(AUTO_MODEL_ID, "GPT-5.6 Luna", cost(0, 0)) } },
    { id: "anthropic", name: "Anthropic", source: "api", env: [], models: { "claude-opus-4-6": model("claude-opus-4-6", "Claude Opus 4.6") } },
    { id: "lpr_team", name: "Team Claude", source: "config", env: [], models: { "claude-haiku": model("claude-haiku", "Claude Haiku") } },
  ];
  return { all, connected, default: {} } as unknown as Parameters<typeof runtimeModelOptions>[0];
}
const allow: ModelCatalogInput["checkRestriction"] = () => false;
const keys = (options: readonly ModelOption[]) => options.map((option) => `${option.providerID}/${option.modelID}`);
const catalogFor = (connected: string[], overrides: Partial<ModelCatalogInput> = {}, zenKey = false) => buildModelCatalog({
  runtime: runtimeModelOptions(providerList(connected, zenKey)), signedIn: true, restrictToCloud: false, checkRestriction: allow, ...overrides,
});

describe("one catalog for every picker", () => {
  test("engine data marks the zero-cost Zen starter as free, so it steps aside once Auto or any real model exists", () => {
    expect(keys(catalogFor(["opencode"]).options)).toEqual(["opencode/big-pickle"]);
    expect(keys(catalogFor(["opencode", AUTO_PROVIDER_ID]).options)).toEqual([`${AUTO_PROVIDER_ID}/${AUTO_MODEL_ID}`]);
    expect(keys(catalogFor(["opencode", "anthropic"]).options)).toEqual(["anthropic/claude-opus-4-6"]);
    // Zen models unlocked with a pasted key stay listed.
    expect(keys(catalogFor(["opencode"], {}, true).options)).toEqual(["opencode/claude-sonnet-4-6"]);
  });

  test("assigned organization models stay listed while the engine syncs, and the engine's record wins where both exist", () => {
    const assigned = { providerID: "lpr_team", modelID: "claude-haiku", title: "Assigned Haiku", description: "Team", behaviorTitle: "", behaviorLabel: "", behaviorDescription: "", behaviorValue: null, isFree: false, organizationPinOrder: 0 } satisfies ModelOption;
    const syncing = { ...assigned, modelID: "claude-new", title: "Not synced yet" };
    expect(keys(buildModelCatalog({ runtime: null, fallback: [assigned], signedIn: true, restrictToCloud: false, checkRestriction: allow }).options)).toEqual(["lpr_team/claude-haiku"]);
    const loaded = catalogFor(["anthropic", "lpr_team"], { fallback: [assigned, syncing] });
    expect(keys(loaded.options)).toEqual(["lpr_team/claude-haiku", "lpr_team/claude-new", "anthropic/claude-opus-4-6"]);
    // The engine's title wins; the organization pin is kept.
    expect(loaded.options[0]).toMatchObject({ title: "Claude Haiku", organizationPinOrder: 0 });
  });

  test("signed-out, policy and disabled providers leave the list; disabled rows stay known so a saved choice can be named", () => {
    expect(keys(catalogFor(["anthropic", "lpr_team"], { signedIn: false }).options)).toEqual(["anthropic/claude-opus-4-6"]);
    expect(keys(catalogFor(["anthropic", "lpr_team"], { restrictToCloud: true }).options)).toEqual(["lpr_team/claude-haiku"]);
    const disabled = catalogFor(["anthropic", "lpr_team"], { disabledProviders: ["anthropic"] });
    expect(keys(disabled.options)).toEqual(["lpr_team/claude-haiku"]);
    expect(disabled.known.find((option) => option.providerID === "anthropic")?.disabled).toBe(true);
  });

  test("gateway models awaiting the member's sign-in are listed with their authorization, and gateway providers are labeled", () => {
    const pending = pendingGatewayModelOptions([{ cloudProviderId: "ipr_vertex", providerId: "ipr_vertex", credentialSetId: "gcs_me", name: "Vertex", authUrl: null,
      models: [{ id: "gwm_gemini", name: "Gemini", credentialSetId: "gcs_me" } as never] }]);
    const catalog = catalogFor(["anthropic"], { pending, gatewayProviderIds: new Set(["ipr_vertex"]) });
    const gemini = catalog.options.find((option) => option.modelID === "gwm_gemini");
    expect(gemini?.gatewayAuthorization).toEqual({ cloudProviderId: "ipr_vertex", credentialSetId: "gcs_me" });
    expect(gemini?.source).toBe("gateway");
  });

  test("Auto carries Den's pin policy, and shortcut targets disable Auto while it cannot run", () => {
    const catalog = catalogFor([AUTO_PROVIDER_ID, "anthropic"], { autoStatus: { providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID, defaultPinned: false } });
    expect(catalog.options.find((option) => option.providerID === AUTO_PROVIDER_ID)?.defaultPinned).toBe(false);
    expect(withAutoActionState(catalog.options, { blocked: true }).find((option) => option.providerID === AUTO_PROVIDER_ID)?.disabled).toBe(true);
    expect(withAutoActionState(catalog.options, { blocked: false }).some((option) => option.disabled)).toBe(false);
  });
});

describe("a saved choice that is not selectable", () => {
  const base = { signedIn: true, restrictToCloud: false, checkRestriction: allow, catalogState: "ready" as const, sessionScoped: true };
  test("names why, from the same rules on every surface", () => {
    const catalog = catalogFor(["anthropic"], { disabledProviders: ["anthropic"] });
    expect(resolveRetainedSelection({ ...base, catalog, current: { providerID: "anthropic", modelID: "claude-opus-4-6" } }))
      .toMatchObject({ reason: "disabled", title: "Claude Opus 4.6" });
    expect(resolveRetainedSelection({ ...base, catalog, current: { providerID: "gone", modelID: "x" } })?.reason).toBe("unavailable");
    expect(resolveRetainedSelection({ ...base, catalog, signedIn: false, current: { providerID: "lpr_team", modelID: "claude-haiku" } }))
      .toMatchObject({ reason: "signed-out", title: undefined });
    expect(resolveRetainedSelection({ ...base, catalog, restrictToCloud: true, current: { providerID: "openai", modelID: "gpt" } })?.reason).toBe("policy");
  });
  test("stays quiet while loading, for a selectable model, and for a new task's untouched starter", () => {
    const catalog = catalogFor(["anthropic"]);
    expect(resolveRetainedSelection({ ...base, catalog, current: { providerID: "anthropic", modelID: "claude-opus-4-6" } })).toBeUndefined();
    expect(resolveRetainedSelection({ ...base, catalog, catalogState: "loading", current: { providerID: "gone", modelID: "x" } })).toBeUndefined();
    expect(resolveRetainedSelection({ ...base, catalog, sessionScoped: false, current: { providerID: "opencode", modelID: "big-pickle" } })).toBeUndefined();
  });
  test("a known policy or disabled block keeps the model out of the list even if its provider reappears", () => {
    const catalog = catalogFor(["anthropic"]);
    const current = { providerID: "anthropic", modelID: "claude-opus-4-6" };
    const retained = resolveRetainedSelection({ ...base, catalog, current, saved: { model: current, reason: "disabled" } });
    expect(retained?.reason).toBe("disabled");
    expect(withoutBlockedSelection(catalog.options, retained)).toEqual([]);
  });
});

test("pickers do not re-derive the catalog: filtering and option building live only in the shared pipeline", () => {
  const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
  for (const path of ["components/model-select.tsx", "react-app/domains/session/modals/model-picker-modal.tsx", "react-app/domains/session/modals/use-model-picker.ts", "react-app/shell/command-palette.tsx"]) {
    const source = read(path);
    for (const derivation of ["filterEntitledModelOptions", "hideBuiltInZenFallback", "getConnectedProviderItems", "filterCloudManagedModelOptions", "recordRecent("]) {
      expect(`${path}: ${source.includes(derivation) ? derivation : "ok"}`).toBe(`${path}: ok`);
    }
  }
});
