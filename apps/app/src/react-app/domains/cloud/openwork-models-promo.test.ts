declare const afterEach: (fn: () => void | Promise<void>) => void;
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toContain: (expected: unknown) => void;
};

import { DEFAULT_DEN_BASE_URL, HOSTED_DEFAULT_DEN_BASE_URL, setDenBootstrapConfig } from "../../../app/lib/den";
import { INFERENCE_ACCESS_REASONS, type InferenceAccess } from "@openwork/types/den/inference";
import { FREE_LUNA_MODEL, inferenceAccessSchema, modelSelectionUpgradeReason, pendingInferenceUsageLabel, shouldSelectInitialLuna } from "../../../app/lib/inference-access";
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
