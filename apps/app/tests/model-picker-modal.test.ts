import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, useState } from "react";
import type { InferenceAccess } from "@openwork/types/den/inference";
import type { ModelOption, ModelRef } from "../src/app/types";
import * as den from "../src/app/lib/den";
import type { DenAuthStore } from "../src/react-app/domains/cloud/den-auth-provider";
import { denSettingsChangedEvent } from "../src/app/lib/den-session-events";
import { MODEL_PREF_KEY } from "../src/app/constants";
import { explicitModelChoiceKey, FREE_LUNA_MODEL, markExplicitModelChoice, modelSelectionUpgradeReason, shouldSelectInitialLuna } from "../src/app/lib/inference-access";
import { LOCAL_PREFERENCES_KEY } from "../src/react-app/kernel/local-preferences-storage";
import { readModelPreferenceBeforeRepair, readStoredDefaultModel, writeStoredDefaultModel } from "../src/react-app/kernel/model-config";
import { resolveEntitledOrgDefaultModel } from "../src/react-app/domains/connections/provider-auth/provider-policy";
// Base UI detects DOM support when its module loads.
GlobalRegistrator.register({ url: "http://localhost" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => { await GlobalRegistrator.unregister(); });
const { createRoot } = await import("react-dom/client");
const auth = await import("../src/react-app/domains/cloud/den-auth-provider");
const desktopConfig = await import("../src/react-app/domains/cloud/desktop-config-provider");
const { InferenceAccessProvider, InferenceAllowanceSummary, useInferenceAccess } = await import("../src/react-app/domains/cloud/inference-access-provider");
const { createDefaultPlatform, PlatformProvider } = await import("../src/react-app/kernel/platform");
const {
  ModelPickerModal,
  MODEL_PICKER_DEFAULT_SUBTITLE,
  MODEL_PICKER_UNAVAILABLE_SUBTITLE,
  resolveModelPickerSubtitle,
} = await import("../src/react-app/domains/session/modals/model-picker-modal");

const modelOption = (modelID: string, providerID = "openwork", title = modelID): ModelOption => ({
  providerID, modelID, title, description: providerID,
  behaviorTitle: "Effort", behaviorLabel: "Default", behaviorDescription: "", behaviorValue: null,
  behaviorOptions: [{ value: "low", label: "Low", description: "" }, { value: "high", label: "High", description: "" }],
  isFree: false,
});

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
  localStorage.removeItem(explicitModelChoiceKey);
  const settings = { ...den.readDenSettings(), baseUrl: "https://den.example.com", activeOrgId: "org-a", authToken: "fixture-a" };
  const authState: DenAuthStore = {
    status: "signed_in", user: null, verifiedIdentity: { principalId: "person-a", organizationId: "org-a" },
    isSignedIn: true, error: null, refresh: async () => undefined,
  };
  const pending: Array<{ orgId: string; resolve: (access: InferenceAccess & { canUpgrade: boolean }) => void }> = [];
  const originalClient = den.createDenClient({ baseUrl: settings.baseUrl });
  const settingsSpy = spyOn(den, "readDenSettings").mockImplementation(() => settings);
  const authSpy = spyOn(auth, "useDenAuth").mockImplementation(() => authState);
  let restrictProviders = false;
  const restrictionSpy = spyOn(desktopConfig, "useCheckDesktopRestriction").mockImplementation(() => () => restrictProviders);
  const clientSpy = spyOn(den, "createDenClient").mockImplementation(() => ({
    ...originalClient,
    getInferenceAccess: (orgId) => new Promise((resolve) => { pending.push({ orgId, resolve }); }),
  }));
  const now = Date.now();
  let clock = now;
  const clockSpy = spyOn(Date, "now").mockImplementation(() => clock);
  const opened: string[] = [];
  const pickerEvents: unknown[] = [];
  const onPicker = (event: Event) => { if (event instanceof CustomEvent) pickerEvents.push(event.detail); };
  window.addEventListener("openwork-open-model-picker", onPicker);
  const selected: ModelRef[] = [];
  const paidModel = modelOption("minimax/minimax-m3", "openwork", "Provider display name");
  const freeModel = modelOption(FREE_LUNA_MODEL.modelID);
  const ownModel = modelOption("fixture-own", "lpr_own");
  const availableModels = [freeModel, paidModel, ownModel];
  const { useModelCollectionsStore } = await import("../src/react-app/domains/session/models/model-collections-store");
  const previousCollections = useModelCollectionsStore.getState();
  useModelCollectionsStore.setState({ favorites: [ownModel, freeModel], recent: [ownModel] });
  const platform = { ...createDefaultPlatform(), openLink: (url: string) => { opened.push(url); } };
  let inference: ReturnType<typeof useInferenceAccess> | undefined;
  function Probe() {
    inference = useInferenceAccess();
    const [query, setQuery] = useState("");
    return createElement("div", null,
      createElement("span", { "data-testid": "access" }, inference.access?.kind ?? "unknown"),
      createElement(InferenceAllowanceSummary),
      createElement(ModelPickerModal, {
        open: Boolean(inference.pickerRequest), options: availableModels, current: ownModel,
        query, setQuery, target: "session", sessionId: "session-b", onSelect: (model) => selected.push(model),
        onBehaviorChange: () => undefined, onOpenSettings: () => undefined, onClose: () => undefined,
      }));
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = () => root.render(createElement(PlatformProvider, { value: platform, children:
    createElement(InferenceAccessProvider, { children: createElement(Probe) }) }));
  const free: InferenceAccess & { canUpgrade: boolean } = {
    kind: "free", modelID: "openai/gpt-5.6-luna", weeklyLimitUsd: 1, usedUsd: 0.2, reservedUsd: 0.1,
    remainingUsd: 0.8, resetsAt: "2026-09-14T00:00:00Z", reason: "free_request_in_progress", canUpgrade: false,
    catalog: [{ modelID: paidModel.modelID, displayName: "Fixture Paid", providerName: "Fixture Provider", summary: "Server supplied benefit", recommended: true, rank: 1, capabilities: ["Reasoning"] }],
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
      expect(inference?.checkSelection(paidModel, "session-b", availableModels, ownModel)).toBe(false);
    });
    expect(document.querySelector('[data-testid="inference-upgrade-dialog"]')?.textContent).toContain("Ask a workspace owner or admin");
    expect(document.querySelector('[data-testid="inference-upgrade-dialog"]')?.textContent).toContain("Unlock Fixture Paid");
    expect(document.querySelector('[data-testid="inference-upgrade-dialog"]')?.textContent).toContain("Server supplied benefit");
    expect(document.querySelector('[data-testid="inference-upgrade-dialog"]')?.textContent).toContain("View plans for current pricing and usage limits");
    expect(document.querySelector('[data-testid="inference-keep-current-model"]')?.textContent).toContain("Keep current model");
    expect(document.querySelector('[data-testid="inference-upgrade-dialog"]')?.textContent).not.toContain("Keep using Luna");
    expect(document.querySelector('[data-testid="inference-upgrade-dialog"]')?.textContent).not.toContain("$");
    expect(document.querySelector('[data-testid="inference-view-upgrade"]')).toBeNull();
    await act(async () => { restrictProviders = true; render(); });
    expect(document.querySelector('[data-testid="model-own-provider"]')).toBeNull();
    expect(selected).toEqual([]);
    expect(localStorage.getItem(explicitModelChoiceKey)).toBeNull();
    expect(opened).toEqual([]);
    for (const { currentModel, label } of [
      { currentModel: ownModel, label: "Keep current model" },
      { currentModel: freeModel, label: "Keep using Luna" },
      { currentModel: { ...freeModel, providerID: "lpr_own" }, label: "Keep current model" },
    ]) {
      await act(async () => { inference?.checkSelection(paidModel, "session-b", availableModels, currentModel); });
      const keep = document.querySelector<HTMLButtonElement>('[data-testid="inference-keep-current-model"]');
      if (!keep) throw new Error("Expected a dismiss-only action for the current model");
      expect(keep.textContent?.trim()).toBe(label);
      await act(async () => keep.click());
      expect(document.querySelector('[data-testid="inference-upgrade-dialog"]')).toBeNull();
      expect(document.querySelector('[data-testid="all-models-picker"]')).toBeNull();
      expect(inference?.pickerRequest).toBeNull();
      expect(pickerEvents).toEqual([]);
      expect(selected).toEqual([]);
      expect(useModelCollectionsStore.getState().favorites).toEqual([ownModel, freeModel]);
      expect(useModelCollectionsStore.getState().recent).toEqual([ownModel]);
      expect(localStorage.getItem(explicitModelChoiceKey)).toBeNull();
    }
    await act(async () => { inference?.showUpgrade("managed_model_requires_upgrade", "session-b", paidModel); });
    expect(document.querySelector('[data-testid="inference-keep-current-model"]')).toBeNull();
    await act(async () => {
      clock += 60_000;
      window.dispatchEvent(new Event("openwork.inference-access-refresh"));
    });
    expect(pending[2]?.orgId).toBe("org-b");
    await act(async () => { pending[2]?.resolve({ ...free, kind: "exhausted", usedUsd: 1, reservedUsd: 0, remainingUsd: 0, reason: "free_allowance_exhausted", canUpgrade: true,
      plan: { name: "Fixture plan", priceLabel: "Server price", usageLabel: "Server usage limits" },
    }); });
    await act(async () => {
      expect(inference?.checkSelection({ providerID: "openwork", modelID: "openai/gpt-5.6-luna" })).toBe(false);
    });
    expect(document.querySelector('[data-testid="inference-upgrade-dialog"]')?.textContent).toContain("Your free Luna allowance is used up");
    expect(document.querySelector('[data-testid="inference-upgrade-plan"]')?.textContent).toContain("Fixture plan · Server price");
    expect(document.querySelector('[data-testid="inference-upgrade-plan"]')?.textContent).toContain("Server usage limits");
    const upgrade = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "View upgrade");
    if (!upgrade) throw new Error("Expected the explicit Upgrade action");
    await act(async () => upgrade.click());
    expect(opened).toEqual(["https://den.example.com/dashboard/inference"]);
    expect(document.body.textContent).not.toContain("fixture-b");
    expect(document.querySelector('[data-testid="inference-upgrade-dialog"]')?.textContent).not.toContain("Keep using Luna");
    await act(async () => { inference?.checkSelection(paidModel, "session-b", availableModels); });
    await act(async () => {
      clock += 60_000;
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => { pending[3]?.resolve({ ...free, kind: "paid", canUpgrade: true }); });
    expect(document.querySelector('[data-testid="inference-upgrade-dialog"]')?.textContent).toContain("Fixture Paid is ready to use");
    expect(pickerEvents).toEqual([]);
    expect(selected).toEqual([]);
    const useModel = document.querySelector<HTMLButtonElement>('[data-testid="inference-use-model"]');
    if (!useModel) throw new Error("Expected explicit continuation after the server grants paid access");
    await act(async () => useModel.click());
    expect(pickerEvents).toEqual([{ sessionId: "session-b" }]);
    expect(inference?.pickerRequest?.model).toEqual(paidModel);
    expect(document.querySelector('[data-testid="requested-model-ready"]')?.textContent).toContain("Select Fixture Paid");
    expect(document.querySelector('[data-requested="true"]')?.textContent).toContain("Fixture Paid");
    expect(document.querySelector('[data-requested="true"]')?.textContent).toContain("Included");
    expect(selected).toEqual([]);
    expect(localStorage.getItem(explicitModelChoiceKey)).toBeNull();
    const choose = document.querySelector<HTMLButtonElement>('[data-requested="true"] button');
    if (!choose) throw new Error("Expected the requested model highlighted in the real picker");
    await act(async () => choose.click());
    expect(selected).toEqual([{ providerID: paidModel.providerID, modelID: paidModel.modelID }]);
    expect(localStorage.getItem(explicitModelChoiceKey)).toBe("1");
    await act(async () => { inference?.showUpgrade("managed_model_requires_upgrade", "session-b", paidModel, availableModels); });
    expect(document.querySelector('[data-testid="inference-use-model"]')).not.toBeNull();
    await act(async () => { window.dispatchEvent(new Event("hashchange")); });
    expect(document.querySelector('[data-testid="inference-use-model"]')).toBeNull();
    await act(async () => {
      authState.status = "signed_out";
      authState.verifiedIdentity = null;
      settings.authToken = "";
      window.dispatchEvent(new Event(denSettingsChangedEvent));
      render();
    });
    expect(inference?.access).toBeNull();
    expect(inference?.pickerRequest).toBeNull();
    expect(inference?.checkSelection({ providerID: "openwork", modelID: "minimax/minimax-m3" })).toBe(true);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    clientSpy.mockRestore();
    settingsSpy.mockRestore();
    authSpy.mockRestore();
    clockSpy.mockRestore();
    restrictionSpy.mockRestore();
    useModelCollectionsStore.setState({ favorites: previousCollections.favorites, recent: previousCollections.recent });
    window.removeEventListener("openwork-open-model-picker", onPicker);
  }
});

test("compact picker opens model rows, dedupes recommendations and favorites, and selects before effort", async () => {
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { WorkspaceProvider } = await import("../src/react-app/shell/workspace-provider");
  const { ModelSelect } = await import("../src/components/model-select");
  const inferenceModule = await import("../src/react-app/domains/cloud/inference-access-provider");
  const { useModelCollectionsStore } = await import("../src/react-app/domains/session/models/model-collections-store");
  const freeModel = modelOption(FREE_LUNA_MODEL.modelID, "openwork", "Fixture Free");
  const paidModel = modelOption("fixture-paid", "openwork", "Fixture Paid");
  const hiddenModel = modelOption("fixture-other", "openwork", "Other managed model");
  const ownModel = modelOption("fixture-own", "lpr_own", "My own model");
  const options = [freeModel, paidModel, hiddenModel, ownModel];
  const access: InferenceAccess & { canUpgrade: boolean } = {
    kind: "free", modelID: freeModel.modelID, weeklyLimitUsd: 1, usedUsd: 0, reservedUsd: 0,
    remainingUsd: 1, resetsAt: null, reason: null, canUpgrade: true,
    catalog: options.slice(0, 2).map((model, rank) => ({ modelID: model.modelID, displayName: model.title, providerName: "Fixture provider", summary: "Fixture summary", recommended: true, rank, capabilities: ["Thinking"] })),
  };
  const selected: ModelRef[] = [];
  const behaviors: Array<string | null> = [];
  const locked: ModelRef[] = [];
  const lockedCurrentModels: Array<ModelRef | undefined> = [];
  let providerSetup = 0;
  const onProvider = () => { providerSetup++; };
  window.addEventListener("openwork-open-provider-auth", onProvider);
  const authSpy = spyOn(auth, "useDenAuth").mockReturnValue({ status: "signed_in", user: null, verifiedIdentity: { principalId: "fixture", organizationId: "fixture" }, isSignedIn: true, error: null, refresh: async () => undefined });
  const restrictionSpy = spyOn(desktopConfig, "useCheckDesktopRestriction").mockImplementation(() => () => false);
  const inferenceSpy = spyOn(inferenceModule, "useInferenceAccess").mockReturnValue({ access, pickerRequest: null, showUpgrade: () => undefined, checkSelection: (model, _sessionId, _availableModels, currentModel) => {
    if (modelSelectionUpgradeReason(access, model)) { locked.push(model); lockedCurrentModels.push(currentModel); return false; }
    return true;
  } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  localStorage.removeItem(explicitModelChoiceKey);
  useModelCollectionsStore.setState({ favorites: [paidModel, ownModel], recent: [freeModel, ownModel] });
  function Picker() {
    const [open, setOpen] = useState(false);
    const [value, setValue] = useState<ModelRef>(ownModel);
    return createElement(ModelSelect, { open, onOpenChange: setOpen, value, fallbackOptions: options,
      onChange: (model) => { selected.push(model); setValue(model); }, onBehaviorChange: (value) => behaviors.push(value),
    });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const click = async (selector: string) => {
    const button = document.querySelector<HTMLElement>(selector);
    if (!button) throw new Error(`Missing picker control: ${selector}`);
    await act(async () => button.click());
  };
  const search = async (value: string) => {
    const input = document.querySelector<HTMLInputElement>('[aria-label="Search all models"]');
    if (!input) throw new Error("Missing model search");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  try {
    await act(async () => root.render(createElement(PlatformProvider, { value: createDefaultPlatform(), children:
      createElement(QueryClientProvider, { client: queryClient, children:
        createElement(WorkspaceProvider, { client: null, selectedWorkspaceRoot: "", children: createElement(Picker) }) }) })));
    await click('[aria-label="Change model"]');
    expect(document.querySelector('[data-testid="managed-model-picker"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Search all models"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="model-select-root"]')).toBeNull();
    expect(document.querySelector('[data-slot="model-thinking-submenu"]')).toBeNull();
    expect(document.querySelectorAll('[data-testid="model-option-openwork-fixture-paid"]').length).toBe(1);
    expect(document.querySelector('[data-testid="model-option-openwork-fixture-paid"]')?.textContent).toContain("Upgrade");
    expect(document.querySelector('[data-testid="model-option-openwork-fixture-paid"]')?.getAttribute("aria-label")).toContain("opens upgrade options without changing your model");
    expect(document.querySelector(`[data-testid="model-option-openwork-${freeModel.modelID}"]`)?.textContent).toContain("Free");
    expect(document.querySelector('[data-testid="model-option-lpr_own-fixture-own"]')?.textContent).not.toContain("Upgrade");
    expect(document.querySelector('[data-testid="model-option-openwork-fixture-other"]')).toBeNull();
    expect(selected).toEqual([]);
    await search("Other managed model");
    expect(document.querySelector('[data-testid="model-option-openwork-fixture-other"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="model-option-openwork-fixture-paid"]')).toBeNull();
    await search("");
    await click('[data-testid="model-option-openwork-fixture-paid"]');
    expect(locked).toEqual([paidModel]);
    expect(lockedCurrentModels).toEqual([ownModel]);
    expect(selected).toEqual([]);
    expect(behaviors).toEqual([]);
    expect(localStorage.getItem(explicitModelChoiceKey)).toBeNull();
    expect(useModelCollectionsStore.getState().favorites).toEqual([paidModel, ownModel]);
    await click('[aria-label="Change model"]');
    await search("Fixture Free");
    await act(async () => {
      document.querySelector('[aria-label="Search all models"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(selected).toEqual([{ providerID: freeModel.providerID, modelID: freeModel.modelID }]);
    expect(behaviors).toEqual([]);
    expect(localStorage.getItem(explicitModelChoiceKey)).toBe("1");
    expect(document.querySelector('[data-slot="model-thinking-submenu"]')).toBeNull();
    await click('[aria-label="Change model"]');
    await click('[aria-label="Thinking and effort for Fixture Free"]');
    expect(document.querySelector('[data-slot="model-thinking-submenu"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Back to models");
    const effort = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="model-thinking-submenu"] button')).find((button) => button.textContent === "High");
    if (!effort) throw new Error("Missing selected model effort option");
    await act(async () => effort.click());
    expect(behaviors).toEqual(["high"]);
    expect(selected.length).toBe(1);
    await click('[aria-label="Change model"]');
    await click('[aria-label="Cycle favorite models"]');
    expect(selected[1]).toEqual({ providerID: ownModel.providerID, modelID: ownModel.modelID });
    expect(locked.length).toBe(1);
    await click('[aria-label="Change model"]');
    await click('[data-testid="model-own-provider"]');
    expect(providerSetup).toBe(1);
    access.catalog = undefined;
    await click('[aria-label="Change model"]');
    expect(document.querySelector('[data-testid="model-option-openwork-fixture-other"]')).not.toBeNull();
    await act(async () => { window.location.hash = "/workspace/fixture/settings/preferences"; });
    await click('[data-testid="model-own-provider"]');
    expect(window.location.hash).toBe("#/workspace/fixture/settings/ai");
    expect(providerSetup).toBe(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    queryClient.clear();
    authSpy.mockRestore();
    restrictionSpy.mockRestore();
    inferenceSpy.mockRestore();
    useModelCollectionsStore.setState({ favorites: [], recent: [] });
    window.removeEventListener("openwork-open-provider-auth", onProvider);
    window.location.hash = "";
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
