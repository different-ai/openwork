declare const afterEach: (fn: () => void | Promise<void>) => void;
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toContain: (expected: unknown) => void;
};

import { DEFAULT_DEN_BASE_URL, HOSTED_DEFAULT_DEN_BASE_URL, setDenBootstrapConfig } from "../../../app/lib/den";
import { INFERENCE_ACCESS_REASONS, type InferenceAccess } from "@openwork/types/den/inference";
import { FREE_LUNA_MODEL, inferenceAccessSchema, managedModelAccessLabel, managedModelRecommendation, managedModelRecommendations, modelPickerView, modelSelectionUpgradeReason, pendingInferenceUsageLabel, shouldSelectInitialLuna } from "../../../app/lib/inference-access";
import type { ModelOption } from "../../../app/types";
import { nextFavoriteModel } from "../session/models/model-collections-store";
import {
  hasOpenWorkModelsAvailable,
  isOpenWorkModelsPromoEligible,
  isOpenWorkModelsPromoEligibleForDenBaseUrl,
  shouldShowOpenWorkModelsPromo,
  shouldShowOpenWorkModelsSyncing,
  wasOpenWorkModelsStartupPromoShown,
} from "./openwork-models-promo";

afterEach(async () => {
  await setDenBootstrapConfig({ baseUrl: DEFAULT_DEN_BASE_URL, requireSignin: false });
});

describe("OpenWork Models promo eligibility", () => {
  test("allows promotions on the default Den URL after normalization", () => {
    expect(isOpenWorkModelsPromoEligibleForDenBaseUrl(`${HOSTED_DEFAULT_DEN_BASE_URL}/api/den/`)).toBe(true);
  });

  test("suppresses promotions for custom configured Den URLs", async () => {
    await setDenBootstrapConfig({ baseUrl: "https://custom-den.example.com", requireSignin: false });

    expect(isOpenWorkModelsPromoEligible()).toBe(false);
    expect(shouldShowOpenWorkModelsPromo()).toBe(false);
    expect(wasOpenWorkModelsStartupPromoShown()).toBe(true);
  });
});

describe("hasOpenWorkModelsAvailable", () => {
  test("requires a connected openwork provider with at least one model", () => {
    expect(
      hasOpenWorkModelsAvailable({
        providerConnectedIds: ["openwork"],
        providers: [{ id: "openwork", models: {} }],
      }),
    ).toBe(false);
    expect(
      hasOpenWorkModelsAvailable({
        providerConnectedIds: ["openwork"],
        providers: [{ id: "openwork", models: { "gpt-5": {} } }],
      }),
    ).toBe(true);
  });
});

describe("shouldShowOpenWorkModelsSyncing", () => {
  test("only reports a real pending workspace reload", () => {
    expect(shouldShowOpenWorkModelsSyncing({
      entitled: true,
      available: false,
      workspaceReady: false,
      reloadPending: true,
    })).toBe(false);
    expect(shouldShowOpenWorkModelsSyncing({
      entitled: true,
      available: false,
      workspaceReady: true,
      reloadPending: false,
    })).toBe(false);
    expect(shouldShowOpenWorkModelsSyncing({
      entitled: true,
      available: false,
      workspaceReady: true,
      reloadPending: true,
    })).toBe(true);
  });
});

const freeAccess: InferenceAccess & { canUpgrade: boolean } = {
  kind: "free", modelID: "openai/gpt-5.6-luna", weeklyLimitUsd: 1, usedUsd: 0.2,
  reservedUsd: 0, remainingUsd: 0.8, resetsAt: "2026-09-14T00:00:00.000Z", reason: null, canUpgrade: true,
};

describe("member allowance model decisions", () => {
  test("restricts only positively managed session catalogs, not settings or legacy provider selection", () => {
    const options: ModelOption[] = ["opencode", "openwork", "lpr_own", "anthropic"].map((providerID) => ({
      providerID, modelID: "fixture", title: "Fixture", behaviorTitle: "", behaviorLabel: "", behaviorDescription: "", behaviorValue: null, isFree: false,
    }));
    const kinds: InferenceAccess["kind"][] = ["free", "exhausted", "paid"];
    for (const kind of kinds) {
      const access = { ...freeAccess, kind };
      const view = modelPickerView(options, { access, signedIn: true, target: "session" });
      expect(view.managedOnly).toBe(true);
      expect(view.options.map((model) => model.providerID).join(",")).toBe("openwork");
      expect(modelPickerView(options, { access, signedIn: true, target: "default" }).options).toBe(options);
      expect(modelPickerView(options, { access, signedIn: false, target: "session" }).options).toBe(options);
      const waiting = modelPickerView(options.filter((model) => model.providerID !== "openwork"), { access, signedIn: true, target: "session" });
      expect(waiting.managedOnly).toBe(true);
      expect(waiting.options.length).toBe(0);
    }
    const legacyAccess: Array<InferenceAccess | null> = [null, { ...freeAccess, kind: "unavailable", reason: "free_disabled" }];
    for (const access of legacyAccess) {
      const view = modelPickerView(options, { access, signedIn: true, target: "session" });
      expect(view.managedOnly).toBe(false);
      expect(view.options).toBe(options);
    }
    expect(options.map((model) => model.providerID).join(",")).toBe("opencode,openwork,lpr_own,anthropic");
  });

  test("gates only paid OpenWork selections, never Luna or organization BYOK", () => {
    expect(modelSelectionUpgradeReason(freeAccess, FREE_LUNA_MODEL)).toBe(null);
    expect(modelSelectionUpgradeReason(freeAccess, { providerID: "openwork", modelID: "openai/gpt-5.6-luna-fast" })).toBe("managed_model_requires_upgrade");
    expect(modelSelectionUpgradeReason(freeAccess, { providerID: "lpr_managed", modelID: "openai/gpt-5.6-luna-fast" })).toBe(null);
    expect(modelSelectionUpgradeReason(freeAccess, { providerID: "opencode", modelID: "big-pickle" })).toBe(null);
    expect(modelSelectionUpgradeReason({ ...freeAccess, kind: "paid" }, { providerID: "openwork", modelID: "minimax/minimax-m3" })).toBe(null);
    expect(modelSelectionUpgradeReason({ ...freeAccess, kind: "exhausted" }, FREE_LUNA_MODEL)).toBe("free_allowance_exhausted");
    expect(modelSelectionUpgradeReason({ ...freeAccess, kind: "unavailable", reason: "free_disabled" }, FREE_LUNA_MODEL)).toBe(null);
    expect(modelSelectionUpgradeReason(null, FREE_LUNA_MODEL)).toBe(null);
  });

  test("selects Luna once for verified first setup, despite the automatic Big Pickle preference", () => {
    const first = {
      installationRequiresSignin: true, signedIn: true, access: freeAccess, modelAvailable: true,
      emptyFirstTask: true, setupComplete: false, explicitChoice: false,
      currentModel: { providerID: "opencode", modelID: "big-pickle" }, variant: null,
    };
    expect(shouldSelectInitialLuna(first)).toBe(true);
    for (const change of [
      { installationRequiresSignin: false }, { signedIn: false }, { modelAvailable: false },
      { emptyFirstTask: false }, { setupComplete: true }, { explicitChoice: true },
      { currentModel: { providerID: "openwork", modelID: "minimax/minimax-m3" } },
      { currentModel: { providerID: "lpr_byok", modelID: "openai/gpt-5.6-luna" } },
      { access: null }, { access: { ...freeAccess, kind: "paid" as const } },
      { access: { ...freeAccess, kind: "unavailable" as const } },
    ]) expect(shouldSelectInitialLuna({ ...first, ...change })).toBe(false);
  });

  test("validates USD and permissions and strips unrelated response fields", () => {
    const parsed = inferenceAccessSchema.parse({ ...freeAccess, token: "not-for-the-ui" });
    expect("token" in parsed).toBe(false);
    expect(parsed.remainingUsd).toBe(0.8);
    expect(inferenceAccessSchema.safeParse({ ...freeAccess, canUpgrade: undefined }).success).toBe(false);
    expect(inferenceAccessSchema.safeParse({ ...freeAccess, remainingUsd: -1 }).success).toBe(false);
    expect(inferenceAccessSchema.safeParse({ ...freeAccess, resetsAt: "invalid" }).success).toBe(false);
  });

  test("validates optional catalog and plan data without losing authoritative access", () => {
    const catalog = [{ modelID: "fixture-paid", displayName: "Fixture model", providerName: "Fixture provider", summary: "Server summary", recommended: true, rank: 1, capabilities: ["Reasoning"], token: "discard" }];
    const plan = { name: "Fixture plan", priceLabel: null, usageLabel: "Server limits", checkoutSecret: "discard" };
    const parsed = inferenceAccessSchema.parse({ ...freeAccess, catalog, plan });
    expect(parsed.catalog?.[0]?.summary).toBe("Server summary");
    expect(parsed.catalog?.[0] && "token" in parsed.catalog[0]).toBe(false);
    expect(parsed.plan?.priceLabel).toBe(null);
    expect(parsed.plan && "checkoutSecret" in parsed.plan).toBe(false);
    for (const invalid of [null, "unexpected", [{ ...catalog[0], rank: "1" }], [{ ...catalog[0], capabilities: [12] }]]) {
      const access = inferenceAccessSchema.parse({ ...freeAccess, catalog: invalid, plan: { priceLabel: 20 } });
      expect(access.kind).toBe("free");
      expect(access.canUpgrade).toBe(true);
      expect(access.catalog).toBe(undefined);
      expect(access.plan).toBe(undefined);
      expect(modelSelectionUpgradeReason(access, { providerID: "openwork", modelID: "fixture-paid" })).toBe("managed_model_requires_upgrade");
    }
  });

  test("intersects ranked recommendations with available managed models and caps the section at four", () => {
    const option = (modelID: string, providerID = "openwork"): ModelOption => ({
      providerID, modelID, title: modelID, behaviorTitle: "", behaviorLabel: "", behaviorDescription: "", behaviorValue: null, isFree: true,
    });
    const models = [FREE_LUNA_MODEL.modelID, "fixture-a", "fixture-b", "fixture-c", "fixture-d"];
    const options = models.map((id) => option(id));
    const access: InferenceAccess = { ...freeAccess, catalog: ["unavailable", ...models.slice(1).reverse(), models[1]].map((modelID, rank) => ({
      modelID, displayName: modelID, providerName: "Fixture", summary: "", recommended: true, rank, capabilities: [],
    })) };
    expect(managedModelRecommendations(access, options).map((model) => model.modelID).join(",")).toBe([models[0], models[4], models[3], models[2]].join(","));
    expect(managedModelRecommendations(access, [option("fixture-a", "lpr_own"), option("fixture-b", "opencode"), { ...option("fixture-c"), disabled: true }]).length).toBe(0);
    expect(managedModelRecommendations(null, options).length).toBe(0);
    expect(managedModelRecommendations(freeAccess, options).length).toBe(0);
    expect(managedModelRecommendation(access, option("fixture-a", "lpr_own"))).toBe(undefined);
    expect(managedModelAccessLabel(freeAccess, option("fixture-a"))).toBe("Upgrade");
    expect(managedModelAccessLabel(freeAccess, option(FREE_LUNA_MODEL.modelID))).toBe("Free");
    expect(managedModelAccessLabel({ ...freeAccess, kind: "paid" }, option("fixture-a"))).toBe("Included");
    expect(managedModelAccessLabel(freeAccess, option("fixture-a", "lpr_own"))).toBe(null);
    expect(managedModelAccessLabel(freeAccess, option("fixture-a", "opencode"))).toBe(null);
    expect(managedModelAccessLabel(null, option("fixture-a"))).toBe(null);
  });

  test("accepts canonical busy access as free and labels pending cost as an estimate", () => {
    const busy = inferenceAccessSchema.parse({ ...freeAccess, reason: "free_request_in_progress", reservedUsd: 0.1 });
    expect(busy.kind).toBe("free");
    expect(busy.remainingUsd).toBe(0.8);
    expect(modelSelectionUpgradeReason(busy, FREE_LUNA_MODEL)).toBe(null);
    expect(pendingInferenceUsageLabel(busy)).toContain("awaiting final usage");
    expect(pendingInferenceUsageLabel(busy)).toContain("Estimated pending cost: $0.10; the final charge may differ.");
    for (const reason of INFERENCE_ACCESS_REASONS) {
      expect(inferenceAccessSchema.safeParse({ ...freeAccess, reason }).success).toBe(true);
    }
    expect(inferenceAccessSchema.safeParse({ ...freeAccess, reason: "insufficient_request_budget" }).success).toBe(false);
  });

  test("keyboard cycling can reach Luna past paid favorites without selecting them", () => {
    const current = { providerID: "opencode", modelID: "big-pickle" };
    const favorites = [current, { providerID: "openwork", modelID: "minimax/minimax-m3" }, FREE_LUNA_MODEL];
    const available = favorites.filter((model) => !modelSelectionUpgradeReason(freeAccess, model));
    expect(nextFavoriteModel(available, current)?.modelID).toBe(FREE_LUNA_MODEL.modelID);
  });
});
