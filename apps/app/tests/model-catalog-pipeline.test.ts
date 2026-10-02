import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ModelOption } from "../src/app/types";
import { buildModelCatalog, resolveRetainedSelection, runtimeModelOptions, withAutoActionState, withoutBlockedSelection, type ModelCatalogInput } from "../src/react-app/domains/models/catalog";
import { AUTO_MODEL_ID, AUTO_PROVIDER_ID } from "../src/react-app/domains/models/model-catalog";
import { pendingGatewayModelOptions } from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";
import { filterCloudManagedModelOptions, markDisabledModelOptions, mergeModelOptions } from "../src/react-app/domains/connections/provider-auth/assigned-model-options";
import { filterEntitledModelOptions } from "../src/react-app/domains/connections/provider-auth/provider-policy";

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
    { id: AUTO_PROVIDER_ID, name: "OpenWork Models (Free)", source: "config", env: [], models: { [AUTO_MODEL_ID]: model(AUTO_MODEL_ID, "GPT-6 Luna", cost(0, 0)) } },
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

describe("free Auto before it is switched on", () => {
  const status = (code: string | null, state = "unavailable") => ({ providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID, state, code });
  test("Auto does not appear while the Gateway reports it switched off, or before its first check answers", () => {
    for (const code of ["free_disabled", "inference_disabled"]) {
      expect(keys(catalogFor(["opencode", AUTO_PROVIDER_ID, "anthropic"], { autoStatus: status(code) }).options)).toEqual(["anthropic/claude-opus-4-6"]);
    }
    // Running, but not for this organization: Auto stays listed so the picker can say why.
    for (const code of ["free_not_enrolled", "free_not_offered", "not_eligible"]) {
      expect(keys(catalogFor(["opencode", AUTO_PROVIDER_ID, "anthropic"], { autoStatus: status(code) }).options)).toContain(`${AUTO_PROVIDER_ID}/${AUTO_MODEL_ID}`);
    }
    expect(keys(catalogFor(["opencode", AUTO_PROVIDER_ID, "anthropic"], { autoPending: true }).options)).toEqual(["anthropic/claude-opus-4-6"]);
    // With nothing else connected, a switched-off Auto still leaves the built-in Zen starter, exactly as today.
    expect(keys(catalogFor(["opencode", AUTO_PROVIDER_ID], { autoStatus: status("free_disabled") }).options)).toEqual(["opencode/big-pickle"]);
  });
  test("Auto that is on but failing is still listed, so the picker can say it is unavailable", () => {
    for (const code of ["anonymous_unavailable", "anonymous_capacity_exceeded", null]) {
      expect(keys(catalogFor([AUTO_PROVIDER_ID, "anthropic"], { autoStatus: status(code) }).options)).toContain(`${AUTO_PROVIDER_ID}/${AUTO_MODEL_ID}`);
    }
    expect(keys(catalogFor([AUTO_PROVIDER_ID], { autoStatus: status(null, "ready") }).options)).toEqual([`${AUTO_PROVIDER_ID}/${AUTO_MODEL_ID}`]);
  });
  test("a conversation already on Auto is named, not called unavailable, while switched off or still checking", () => {
    const current = { providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID };
    const catalog = catalogFor([AUTO_PROVIDER_ID, "anthropic"], { autoStatus: status("free_disabled") });
    expect(catalog.known.some((option) => option.providerID === AUTO_PROVIDER_ID)).toBe(true);
    expect(resolveRetainedSelection({ current, catalog, signedIn: true, restrictToCloud: false, checkRestriction: allow, catalogState: "loading", sessionScoped: true })).toBeUndefined();
  });
});

describe("providers people set up outside OpenWork keep all their models", () => {
  const withSource = (id: string, source: string, models: Record<string, ReturnType<typeof model>>) => {
    const list = providerList([id, "anthropic"]);
    const all = (list as unknown as { all: Array<Record<string, unknown>> }).all.filter((provider) => provider.id !== id);
    all.push({ id, name: id, source, env: [], models });
    return { ...list, all } as typeof list;
  };
  test("Zen set up with a subscription or key (OpenWork, opencode auth login, env or config) keeps every model, free ones included", () => {
    const zen = { "big-pickle": model("big-pickle", "Big Pickle", cost(0, 0)), "claude-sonnet-4-6": model("claude-sonnet-4-6", "Claude Sonnet 4.6") };
    for (const source of ["api", "env", "config"]) {
      const options = buildModelCatalog({ runtime: runtimeModelOptions(withSource("opencode", source, zen)), signedIn: true, restrictToCloud: false, checkRestriction: allow }).options;
      expect(keys(options)).toEqual(expect.arrayContaining(["opencode/big-pickle", "opencode/claude-sonnet-4-6", "anthropic/claude-opus-4-6"]));
    }
    // Only the built-in Zen nobody configured steps aside once a real model exists.
    const builtIn = buildModelCatalog({ runtime: runtimeModelOptions(withSource("opencode", "custom", { "big-pickle": zen["big-pickle"] })), signedIn: true, restrictToCloud: false, checkRestriction: allow }).options;
    expect(keys(builtIn)).toEqual(["anthropic/claude-opus-4-6"]);
  });
  test("OpenAI signed in through the Codex CLI stays listed, whatever source the engine reports", () => {
    for (const source of ["api", "custom", "env", "config"]) {
      const options = buildModelCatalog({ runtime: runtimeModelOptions(withSource("openai", source, { "gpt-5.6": model("gpt-5.6", "GPT-5.6") })), signedIn: true, restrictToCloud: false, checkRestriction: allow }).options;
      expect(keys(options)).toContain("openai/gpt-5.6");
    }
  });
});

describe("enterprise: only managed providers", () => {
  // Desktop policy with allowCustomProviders off; allowZenModel decides Zen, as it always has.
  const policy = (zenAllowed: boolean): ModelCatalogInput["checkRestriction"] => (input) =>
    input.restriction === "allowCustomProviders" ? true : input.restriction === "allowZenModel" ? !zenAllowed : false;
  const everything = ["opencode", AUTO_PROVIDER_ID, "anthropic", "lpr_team"];
  test("the picker offers exactly what the existing policy filter allows: managed providers, never Auto or personal keys", () => {
    for (const zenAllowed of [true, false]) {
      for (const autoStatus of [undefined, { providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID, state: "ready", code: null }]) {
        const checkRestriction = policy(zenAllowed);
        const runtime = runtimeModelOptions(providerList(everything, true));
        const catalog = buildModelCatalog({ runtime, signedIn: true, restrictToCloud: true, checkRestriction, autoStatus });
        // The same filter chain dev applies to the engine's models under this policy.
        const devEquivalent = filterEntitledModelOptions(markDisabledModelOptions(filterCloudManagedModelOptions(mergeModelOptions(runtime, []), true), []), { restrictToCloud: true, checkRestriction });
        expect(keys(catalog.options)).toEqual(keys(devEquivalent));
        expect(keys(catalog.options)).not.toContain(`${AUTO_PROVIDER_ID}/${AUTO_MODEL_ID}`);
        expect(keys(catalog.options)).not.toContain("anthropic/claude-opus-4-6");
        expect(keys(catalog.options)).toContain("lpr_team/claude-haiku");
        expect(keys(catalog.options).some((key) => key.startsWith("opencode/"))).toBe(zenAllowed);
      }
    }
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
  test("the free Zen starter hidden behind better models still works, so it is never called unavailable", () => {
    const catalog = catalogFor(["opencode", "anthropic"]);
    const current = { providerID: "opencode", modelID: "big-pickle" };
    expect(keys(catalog.options)).not.toContain("opencode/big-pickle");
    expect(resolveRetainedSelection({ ...base, catalog, current })).toBeUndefined();
    expect(resolveRetainedSelection({ ...base, catalog, sessionScoped: false, current })).toBeUndefined();
    expect(resolveRetainedSelection({ ...base, catalog, current, saved: { model: current, reason: "disabled" } })?.reason).toBe("disabled");
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
