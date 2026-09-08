import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import type { InferenceAccess } from "@openwork/types/den/inference";
import * as den from "../src/app/lib/den";
import type { DenAuthStore } from "../src/react-app/domains/cloud/den-auth-provider";
import { denSettingsChangedEvent } from "../src/app/lib/den-session-events";
import { MODEL_PREF_KEY } from "../src/app/constants";
import { explicitModelChoiceKey, FREE_LUNA_MODEL, markExplicitModelChoice, shouldSelectInitialLuna } from "../src/app/lib/inference-access";
import { LOCAL_PREFERENCES_KEY } from "../src/react-app/kernel/local-preferences-storage";
import { readModelPreferenceBeforeRepair, readStoredDefaultModel, writeStoredDefaultModel } from "../src/react-app/kernel/model-config";
import { resolveEntitledOrgDefaultModel } from "../src/react-app/domains/connections/provider-auth/provider-policy";
// Base UI detects DOM support when its module loads.
GlobalRegistrator.register({ url: "http://localhost" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => { await GlobalRegistrator.unregister(); });
const { createRoot } = await import("react-dom/client");
const auth = await import("../src/react-app/domains/cloud/den-auth-provider");
const { InferenceAccessProvider, InferenceAllowanceSummary, useInferenceAccess } = await import("../src/react-app/domains/cloud/inference-access-provider");
const { createDefaultPlatform, PlatformProvider } = await import("../src/react-app/kernel/platform");
const {
  MODEL_PICKER_DEFAULT_SUBTITLE,
  MODEL_PICKER_UNAVAILABLE_SUBTITLE,
  resolveModelPickerSubtitle,
} = await import("../src/react-app/domains/session/modals/model-picker-modal");

describe("model picker subtitle", () => {
  test("keeps the normal session subtitle by default", () => {
    expect(resolveModelPickerSubtitle(undefined)).toBe(MODEL_PICKER_DEFAULT_SUBTITLE);
  });

  test("supports the unavailable-model recovery subtitle", () => {
    expect(resolveModelPickerSubtitle(MODEL_PICKER_UNAVAILABLE_SUBTITLE)).toBe(
      "The model you were using is no longer available, please select a different model for this session.",
    );
  });
});

test("member access ignores stale organization reads and opens upgrades only on a managed selection", async () => {
  const settings = { ...den.readDenSettings(), baseUrl: "https://den.example.com", activeOrgId: "org-a", authToken: "fixture-a" };
  const authState: DenAuthStore = {
    status: "signed_in", user: null, verifiedIdentity: { principalId: "person-a", organizationId: "org-a" },
    isSignedIn: true, error: null, refresh: async () => undefined,
  };
  const pending: Array<{ orgId: string; resolve: (access: InferenceAccess & { canUpgrade: boolean }) => void }> = [];
  const originalClient = den.createDenClient({ baseUrl: settings.baseUrl });
  const settingsSpy = spyOn(den, "readDenSettings").mockImplementation(() => settings);
  const authSpy = spyOn(auth, "useDenAuth").mockImplementation(() => authState);
  const clientSpy = spyOn(den, "createDenClient").mockImplementation(() => ({
    ...originalClient,
    getInferenceAccess: (orgId) => new Promise((resolve) => { pending.push({ orgId, resolve }); }),
  }));
  const now = Date.now();
  let clock = now;
  const clockSpy = spyOn(Date, "now").mockImplementation(() => clock);
  const opened: string[] = [];
  const platform = { ...createDefaultPlatform(), openLink: (url: string) => { opened.push(url); } };
  let inference: ReturnType<typeof useInferenceAccess> | undefined;
  function Probe() {
    inference = useInferenceAccess();
    return createElement("div", null,
      createElement("span", { "data-testid": "access" }, inference.access?.kind ?? "unknown"),
      createElement(InferenceAllowanceSummary));
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = () => root.render(createElement(PlatformProvider, { value: platform, children:
    createElement(InferenceAccessProvider, { children: createElement(Probe) }) }));
  const free: InferenceAccess & { canUpgrade: boolean } = {
    kind: "free", modelID: "openai/gpt-5.6-luna", weeklyLimitUsd: 1, usedUsd: 0.2, reservedUsd: 0.1,
    remainingUsd: 0.8, resetsAt: "2026-09-14T00:00:00Z", reason: "free_request_in_progress", canUpgrade: false,
  };
  try {
    await act(async () => { render(); });
    expect(pending[0]?.orgId).toBe("org-a");
    await act(async () => {
      settings.activeOrgId = "org-b";
      settings.authToken = "fixture-b";
      authState.verifiedIdentity = { principalId: "person-b", organizationId: "org-b" };
      window.dispatchEvent(new Event(denSettingsChangedEvent));
      render();
    });
    expect(pending[1]?.orgId).toBe("org-b");
    await act(async () => { pending[0]?.resolve({ ...free, canUpgrade: true }); });
    expect(inference?.access).toBeNull();
    await act(async () => { pending[1]?.resolve(free); });
    expect(inference?.access?.canUpgrade).toBe(false);
    expect(inference?.access?.kind).toBe("free");
    expect(host.textContent).toContain("$0.80 of $1.00 left this week");
    expect(host.textContent).toContain("Estimated pending cost: $0.10; the final charge may differ.");
    expect(document.querySelector('[data-testid="inference-upgrade-dialog"]')).toBeNull();
    expect(inference?.checkSelection({ providerID: "openwork", modelID: "openai/gpt-5.6-luna" })).toBe(true);
    expect(inference?.checkSelection({ providerID: "lpr_managed", modelID: "minimax/minimax-m3" })).toBe(true);
    await act(async () => {
      expect(inference?.checkSelection({ providerID: "openwork", modelID: "minimax/minimax-m3" })).toBe(false);
    });
    expect(document.querySelector('[data-testid="inference-upgrade-dialog"]')?.textContent).toContain("Ask a workspace owner or admin");
    expect(opened).toEqual([]);
    await act(async () => {
      clock += 60_000;
      window.dispatchEvent(new Event("openwork.inference-access-refresh"));
    });
    expect(pending[2]?.orgId).toBe("org-b");
    await act(async () => { pending[2]?.resolve({ ...free, kind: "exhausted", usedUsd: 1, reservedUsd: 0, remainingUsd: 0, reason: "free_allowance_exhausted", canUpgrade: true }); });
    await act(async () => {
      expect(inference?.checkSelection({ providerID: "openwork", modelID: "openai/gpt-5.6-luna" })).toBe(false);
    });
    expect(document.querySelector('[data-testid="inference-upgrade-dialog"]')?.textContent).toContain("Your free Luna allowance is used up");
    const upgrade = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Upgrade");
    if (!upgrade) throw new Error("Expected the explicit Upgrade action");
    await act(async () => upgrade.click());
    expect(opened).toEqual(["https://den.example.com/dashboard/inference"]);
    expect(document.body.textContent).not.toContain("fixture-b");
    await act(async () => {
      authState.status = "signed_out";
      authState.verifiedIdentity = null;
      settings.authToken = "";
      window.dispatchEvent(new Event(denSettingsChangedEvent));
      render();
    });
    expect(inference?.access).toBeNull();
    expect(inference?.checkSelection({ providerID: "openwork", modelID: "minimax/minimax-m3" })).toBe(true);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    clientSpy.mockRestore();
    settingsSpy.mockRestore();
    authSpy.mockRestore();
    clockSpy.mockRestore();
  }
});

describe("initial Luna and automatic organization default repair", () => {
  const starter = { providerID: "opencode", modelID: "big-pickle" };
  const organizationModel = { providerID: "lpr_organization", modelID: "gpt-5.5" };
  const free: InferenceAccess = {
    kind: "free", modelID: FREE_LUNA_MODEL.modelID, weeklyLimitUsd: 1, usedUsd: 0,
    reservedUsd: 0, remainingUsd: 1, resetsAt: "2026-09-14T00:00:00Z", reason: null,
  };
  const pendingLuna = (access: InferenceAccess | null, variant: string | null = null) => {
    const original = readModelPreferenceBeforeRepair({ model: readStoredDefaultModel(), variant });
    return shouldSelectInitialLuna({
      installationRequiresSignin: true, signedIn: true, access, modelAvailable: true,
      emptyFirstTask: true, setupComplete: false,
      explicitChoice: localStorage.getItem(explicitModelChoiceKey) !== null,
      currentModel: original.model, variant: original.variant,
    });
  };
  const repair = (options = [organizationModel]) => {
    const replacement = resolveEntitledOrgDefaultModel(options, {
      currentDefault: readStoredDefaultModel(), restrictToCloud: true,
      checkRestriction: (input) => input.restriction === "allowZenModel",
    });
    if (replacement) writeStoredDefaultModel(replacement, { automaticRepair: true });
    return replacement;
  };

  test("paid, disabled and unavailable access leave ordinary organization repair enabled", () => {
    const accessStates: Array<InferenceAccess | null> = [
      { ...free, kind: "paid" }, { ...free, kind: "unavailable", reason: "free_disabled" },
      { ...free, kind: "unavailable", reason: "not_eligible" }, null,
    ];
    for (const access of accessStates) {
      localStorage.clear();
      writeStoredDefaultModel(starter);
      expect(pendingLuna(access)).toBe(false);
      expect(repair()).toEqual(organizationModel);
      expect(readStoredDefaultModel()).toEqual(organizationModel);
      expect(pendingLuna(access)).toBe(false);
      expect(localStorage.getItem(explicitModelChoiceKey)).toBeNull();
    }
  });

  test("late free access can initialize Luna after automatic repair, including a preference echo", () => {
    localStorage.clear();
    writeStoredDefaultModel(starter);
    expect(repair()).toEqual(organizationModel);
    // LocalProvider mirrors the stored update; that is not a user selection.
    writeStoredDefaultModel(organizationModel);
    expect(readModelPreferenceBeforeRepair({ model: readStoredDefaultModel(), variant: null })).toEqual({ model: starter, variant: null });
    expect(pendingLuna(free)).toBe(true);
    expect(localStorage.getItem(explicitModelChoiceKey)).toBeNull();
    writeStoredDefaultModel(FREE_LUNA_MODEL);
    expect(repair()).toBeNull();
    expect(readStoredDefaultModel()).toEqual(FREE_LUNA_MODEL);
  });

  test("existing paid and BYOK preferences are not reclassified as automatic starter choices", () => {
    for (const chosen of [{ providerID: "openwork", modelID: "minimax/minimax-m3" }, organizationModel, { providerID: "openai", modelID: "gpt-5.5" }]) {
      localStorage.clear();
      writeStoredDefaultModel(chosen);
      repair();
      expect(readModelPreferenceBeforeRepair({ model: readStoredDefaultModel(), variant: null }).model).toEqual(chosen);
      expect(pendingLuna(free)).toBe(false);
      if (chosen.providerID !== "openai") expect(readStoredDefaultModel()).toEqual(chosen);
    }
  });

  test("an explicit choice of the repaired model or starter prevents subsequent Luna initialization", () => {
    for (const chosen of [organizationModel, starter]) {
      localStorage.clear();
      writeStoredDefaultModel(starter);
      repair();
      markExplicitModelChoice();
      writeStoredDefaultModel(chosen);
      expect(pendingLuna(free)).toBe(false);
      expect(readStoredDefaultModel()).toEqual(chosen);
    }
  });

  test("repair preserves the original effort preference and respects a newer effort choice", () => {
    localStorage.clear();
    writeStoredDefaultModel(starter);
    localStorage.setItem(LOCAL_PREFERENCES_KEY, JSON.stringify({ modelVariant: "high" }));
    repair();
    expect(readModelPreferenceBeforeRepair({ model: readStoredDefaultModel(), variant: null }).variant).toBe("high");
    expect(pendingLuna(free)).toBe(false);
    expect(readModelPreferenceBeforeRepair({ model: readStoredDefaultModel(), variant: "medium" }).variant).toBe("medium");
  });

  test("optional snapshot storage failure does not block paid or BYOK default repair", () => {
    localStorage.clear();
    writeStoredDefaultModel(starter);
    const setItem = localStorage.setItem.bind(localStorage);
    const storageSpy = spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key !== MODEL_PREF_KEY) throw new Error("No room for optional preference metadata");
      setItem(key, value);
    });
    try {
      expect(repair()).toEqual(organizationModel);
      expect(readStoredDefaultModel()).toEqual(organizationModel);
    } finally { storageSpy.mockRestore(); }
  });
});
