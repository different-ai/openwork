import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, useState } from "react";
import type { CreateAutomation } from "@openwork/types/automations";
import type { AutomationProviderCatalog, AutomationModelOption } from "../src/react-app/domains/automations/automation-model-options";
import type { ModelOption } from "../src/app/types";
import { fastVariantId } from "@openwork/types/cloud-model-fast";

// Base UI detects DOM support when its module loads.
GlobalRegistrator.register({ url: "http://localhost" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => { await GlobalRegistrator.unregister(); });
const { createRoot } = await import("react-dom/client");
const auth = await import("../src/react-app/domains/cloud/den-auth-provider");
const defaultPolicy = await import("../src/react-app/domains/cloud/desktop-config-provider");
let restorePolicy = () => {};
beforeEach(() => { const policy = spyOn(defaultPolicy, "useCheckDesktopRestriction").mockReturnValue(() => false); restorePolicy = () => policy.mockRestore(); });
afterEach(() => restorePolicy());
async function openAdvanced() {
  const section = document.querySelector<HTMLDetailsElement>('[data-testid="model-advanced-options"], [data-testid="current-model-settings"]');
  if (section && !section.open) await act(async () => section.querySelector<HTMLElement>("summary")?.click());
}
const { createDefaultPlatform, PlatformProvider } = await import("../src/react-app/kernel/platform");
const { ModelPickerModal, MODEL_PICKER_DEFAULT_SUBTITLE, MODEL_PICKER_UNAVAILABLE_SUBTITLE, resolveModelPickerSubtitle } = await import("../src/react-app/domains/session/modals/model-picker-modal");
import {
  connectGatewayProvider,
  gatewayConnectCopy,
  isCloudManagedProviderKey,
  resolveGatewayConnectProviders,
  resolveGatewayProviderIds,
} from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";

for (const surface of ["compact", "full"]) {
  test(`${surface} picker preserves mobile non-editable focus and explicit effort focus`, async () => {
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { WorkspaceProvider } = await import("../src/react-app/shell/workspace-provider");
    const { ModelSelect } = await import("../src/components/model-select");
    const mobile = await import("../src/hooks/use-mobile");
    const policy = await import("../src/react-app/domains/cloud/desktop-config-provider");
    const mobileSpy = spyOn(mobile, "useIsMobile").mockReturnValue(true);
    const policySpy = spyOn(policy, "useCheckDesktopRestriction").mockReturnValue(() => false);
    const authSpy = spyOn(auth, "useDenAuth").mockReturnValue({ status: "signed_out", user: null, verifiedIdentity: null, isSignedIn: false, error: null, refresh: async () => undefined });
    const current = { providerID: "fixture", modelID: "reasoner" };
    const options: ModelOption[] = [{ ...current, title: "Friendly model", description: "Fixture", isFree: false,
      behaviorTitle: "Effort", behaviorLabel: "Low", behaviorDescription: "", behaviorValue: "low",
      behaviorOptions: [{ value: null, label: "Default", description: "" }, { value: "low", label: "Low", description: "" }] }];
    const client = new QueryClient();
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    function Picker() {
      const [open, setOpen] = useState(true);
      const [query, setQuery] = useState("");
      return surface === "compact" ? createElement(ModelSelect, { open, value: current, fallbackOptions: options, behaviorValue: "low",
        onOpenChange: setOpen, onChange: () => undefined, onBehaviorChange: () => undefined })
        : createElement(ModelPickerModal, { open, current, options, query, setQuery, target: "session", onSelect: () => undefined,
          onBehaviorChange: () => undefined, onOpenSettings: () => undefined, onClose: () => setOpen(false) });
    }
    try {
      await act(async () => root.render(createElement(PlatformProvider, { value: createDefaultPlatform(), children:
        createElement(QueryClientProvider, { client, children: createElement(WorkspaceProvider, { client: null, selectedWorkspaceRoot: "/fixture", children: createElement(Picker) }) }) })));
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
      const input = document.querySelector<HTMLInputElement>('[aria-label="Search all models"]');
      expect(input).not.toBeNull();
      expect(document.activeElement).not.toBe(input);
      expect(input?.className).toContain("text-base");
      if (surface === "compact") {
        await openAdvanced();
        const effort = document.querySelector<HTMLButtonElement>('[data-testid="model-effort"]');
        await act(async () => effort?.click());
        expect(document.activeElement?.textContent).toBe("Back to models");
        await act(async () => document.querySelector<HTMLButtonElement>('[data-slot="model-thinking-submenu"] button')?.click());
        expect(document.activeElement?.getAttribute("data-testid")).toBe("model-effort");
      } else {
        expect(document.activeElement?.textContent).toBe("Models");
      }
    } finally {
      await act(async () => root.unmount()); host.remove(); client.clear(); mobileSpy.mockRestore(); policySpy.mockRestore(); authSpy.mockRestore();
    }
  });
}

test("closed compact trigger hides a missing catalog model ID", async () => {
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { WorkspaceProvider } = await import("../src/react-app/shell/workspace-provider");
  const { ModelSelect } = await import("../src/components/model-select");
  const policy = await import("../src/react-app/domains/cloud/desktop-config-provider");
  const policySpy = spyOn(policy, "useCheckDesktopRestriction").mockReturnValue(() => false);
  const authSpy = spyOn(auth, "useDenAuth").mockReturnValue({ status: "signed_out", user: null, verifiedIdentity: null, isSignedIn: false, error: null, refresh: async () => undefined });
  const client = new QueryClient();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(PlatformProvider, { value: createDefaultPlatform(), children:
      createElement(QueryClientProvider, { client, children: createElement(WorkspaceProvider, { client: null, selectedWorkspaceRoot: "/fixture", children:
        createElement(ModelSelect, { open: false, value: { providerID: "ipr_hidden", modelID: "gwm_hidden" }, onOpenChange: () => undefined, onChange: () => undefined }) }) }) })));
    expect(host.querySelector('[aria-label="Change model"]')?.textContent).toBe("Select model");
    expect(host.textContent).not.toContain("gwm_hidden");
    expect(host.textContent).not.toContain("ipr_hidden");
  } finally { await act(async () => root.unmount()); host.remove(); client.clear(); policySpy.mockRestore(); authSpy.mockRestore(); }
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

test("full picker preserves a stale effort until an explicit choice and never selects a model during effort editing", async () => {
  const authSpy = spyOn(auth, "useDenAuth").mockReturnValue({ status: "signed_out", user: null, verifiedIdentity: null, isSignedIn: false, error: null, refresh: async () => undefined });
  const current = { providerID: "fixture", modelID: "first" };
  const options: ModelOption[] = [{ ...current, title: "Fixture model", description: "Fixture",
    behaviorOptions: [{ value: null, label: "Default", description: "" }, { value: "low", label: "Low", description: "" }], isFree: false }];
  const selected: unknown[] = [];
  const changes: unknown[] = [];
  function Picker() {
    const [value, setValue] = useState<string | null>("retired");
    return createElement(ModelPickerModal, { open: true, options, current, currentBehaviorValue: value,
      target: "session", query: "", setQuery: () => undefined, onSelect: (model) => selected.push(model),
      onBehaviorChange: (model, next) => { changes.push({ model, value: next }); setValue(next); },
      onOpenSettings: () => undefined, onClose: () => undefined });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(PlatformProvider, { value: createDefaultPlatform(), children: createElement(Picker) })));
    await openAdvanced();
    expect(document.querySelector('[data-testid="current-model-settings"]')?.textContent).toContain('"retired" (not in current catalog)');
    expect(document.querySelector('[data-testid="current-model-settings"] [aria-pressed="true"]')).toBeNull();
    for (const label of ["Default", "Low", "Default"]) {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="current-model-settings"] button')).find((item) => item.textContent === label);
      if (!button) throw new Error(`Missing effort ${label}`);
      await act(async () => button.click());
      expect(document.querySelector('[data-testid="current-model-settings"] [aria-pressed="true"]')?.textContent).toBe(label);
    }
    expect(changes).toEqual([null, "low", null].map((value) => ({ model: current, value })));
    expect(selected).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    authSpy.mockRestore();
  }
});

test("compact picker leaves unadvertised effort unavailable but can clear a stale saved value", async () => {
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { WorkspaceProvider } = await import("../src/react-app/shell/workspace-provider");
  const { ModelSelect } = await import("../src/components/model-select");
  const policy = await import("../src/react-app/domains/cloud/desktop-config-provider");
  const policySpy = spyOn(policy, "useCheckDesktopRestriction").mockReturnValue(() => false);
  const authSpy = spyOn(auth, "useDenAuth").mockReturnValue({ status: "signed_out", user: null, verifiedIdentity: null, isSignedIn: false, error: null, refresh: async () => undefined });
  const current = { providerID: "fixture", modelID: "standard" };
  const options: ModelOption[] = [{ ...current, title: "Standard model", description: "Fixture", isFree: false,
    behaviorOptions: [{ value: null, label: "Default", description: "" }] }];
  let value: string | null = null;
  const selected: unknown[] = [];
  const changed: Array<string | null> = [];
  const queryClient = new QueryClient();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = () => root.render(createElement(PlatformProvider, { value: createDefaultPlatform(), children:
    createElement(QueryClientProvider, { client: queryClient, children:
      createElement(WorkspaceProvider, { client: null, selectedWorkspaceRoot: "/fixture", children:
        createElement(ModelSelect, { open: true, value: current, fallbackOptions: options, behaviorValue: value,
          onOpenChange: () => undefined, onChange: (model) => selected.push(model),
          onBehaviorChange: (next) => { value = next; changed.push(next); render(); } }) }) }) }));
  const effortButton = () => document.querySelector<HTMLButtonElement>('[data-testid="model-effort"]');
  try {
    await act(async () => render());
    expect(document.querySelector('[data-testid="model-effort"]')).toBeNull();
    await openAdvanced();
    expect(effortButton()?.disabled).toBe(true);
    expect(effortButton()?.textContent).toContain("Unavailable");
    value = "retired";
    await act(async () => render());
    expect(effortButton()?.disabled).toBe(false);
    await act(async () => effortButton()?.click());
    expect(document.querySelector('[data-slot="model-thinking-submenu"]')?.textContent).toContain("kept unchanged");
    const choices = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="model-thinking-submenu"] button'))
      .filter((button) => button.hasAttribute("aria-pressed"));
    expect(choices).toHaveLength(1);
    expect(choices[0].textContent).toContain("Default");
    expect(choices[0].getAttribute("aria-pressed")).toBe("false");
    await act(async () => choices[0].click());
    expect(changed).toEqual([null]);
    expect(selected).toEqual([]);
    expect(effortButton()?.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    queryClient.clear();
    policySpy.mockRestore();
    authSpy.mockRestore();
  }
});

for (const surface of ["compact", "full"]) {
  test(`${surface} picker toggles native Fast without resetting effort and hides it for legacy catalogs`, async () => {
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { WorkspaceProvider } = await import("../src/react-app/shell/workspace-provider");
    const { ModelSelect } = await import("../src/components/model-select");
    const policy = await import("../src/react-app/domains/cloud/desktop-config-provider");
    const policySpy = spyOn(policy, "useCheckDesktopRestriction").mockReturnValue(() => false);
    const authSpy = spyOn(auth, "useDenAuth").mockReturnValue({ status: "signed_out", user: null, verifiedIdentity: null, isSignedIn: false, error: null, refresh: async () => undefined });
    const current = { providerID: "fixture", modelID: "reasoner" };
    const standard = [null, "low", "high", "CustomExact"].map((value) => ({ value,
      label: value === null ? "Default" : value === "CustomExact" ? value : value.charAt(0).toUpperCase() + value.slice(1), description: "" }));
    let behaviorOptions = [...standard, ...standard.map((option) => ({ ...option, value: fastVariantId(option.value), label: `${option.label} + Fast` }))];
    let value: string | null = "high";
    const changes: Array<string | null> = [];
    const openChanges: boolean[] = [];
    const selected: unknown[] = [];
    const queryClient = new QueryClient();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const change = (next: string | null) => { changes.push(next); value = next; render(); };
    const render = () => {
      const options: ModelOption[] = [{ ...current, title: "Synthetic model", description: "Fixture", isFree: false,
        behaviorTitle: "Effort", behaviorLabel: "Default", behaviorDescription: "", behaviorValue: null, behaviorOptions }];
      const picker = surface === "compact" ? createElement(ModelSelect, {
        open: true, value: current, fallbackOptions: options, behaviorValue: value,
        onOpenChange: (open) => openChanges.push(open), onChange: (model) => selected.push(model), onBehaviorChange: change,
      }) : createElement(ModelPickerModal, {
        open: true, options, current, currentBehaviorValue: value, target: "session", query: "", setQuery: () => undefined,
        onSelect: (model) => selected.push(model), onBehaviorChange: (_model, next) => change(next),
        onOpenSettings: () => undefined, onClose: () => undefined,
      });
      root.render(createElement(PlatformProvider, { value: createDefaultPlatform(), children:
        createElement(QueryClientProvider, { client: queryClient, children:
          createElement(WorkspaceProvider, { client: null, selectedWorkspaceRoot: "/fixture", children: picker }) }) }));
    };
    const settings = () => document.querySelector(surface === "compact" ? '[data-slot="model-thinking-submenu"]' : '[data-testid="current-model-settings"]');
    const openSettings = async () => {
      await openAdvanced();
      if (surface !== "compact" || settings()) return;
      const button = document.querySelector<HTMLButtonElement>('[data-testid="model-effort"]');
      if (!button) throw new Error("Missing effort menu");
      await act(async () => button.click());
    };
    try {
      await act(async () => render());
      if (surface === "compact") expect(document.querySelector('[aria-label="Change model"]')?.textContent).toContain("Synthetic model · High");
      expect(document.querySelector('[aria-label="Fast mode"]')).toBeNull();
      for (const label of ["Fast", "Low", "Fast", "CustomExact", "Fast", "Default", "Fast"]) {
        await openAdvanced();
        if (label === "Fast") {
          const menu = document.querySelector(surface === "compact" ? '[data-testid="composer-model-picker"]' : '[data-testid="current-model-settings"]');
          const toggle = menu?.querySelector<HTMLButtonElement>('[role="switch"]');
          if (!toggle) throw new Error("Missing main-menu Fast mode switch");
          expect(toggle.closest('[title]')?.getAttribute("title") ?? "").not.toContain("pricing");
          const wasChecked = toggle.getAttribute("aria-checked") === "true";
          await act(async () => toggle.click());
          expect(menu?.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe(String(!wasChecked));
          if (surface === "compact") expect(document.querySelector('[data-testid="model-effort"]')?.textContent).not.toContain("Fast");
          continue;
        }
        await openSettings();
        if (surface === "full") expect(settings()?.textContent).not.toContain("higher pricing");
        else expect(settings()?.querySelector('[role="switch"]')).toBeNull();
        const button = Array.from(settings()?.querySelectorAll<HTMLButtonElement>("button") ?? [])
          .find((entry) => label === "Fast" ? entry.textContent?.startsWith("Fast") : entry.textContent === label);
        if (!button) throw new Error(`Missing ${surface} ${label} control`);
        await act(async () => button.click());
      }
      expect(changes).toEqual([fastVariantId("high"), fastVariantId("low"), "low", "CustomExact",
        fastVariantId("CustomExact"), fastVariantId(null), null]);
      expect(selected).toEqual([]);
      expect(openChanges).toEqual([]);
      behaviorOptions = standard;
      value = "high";
      await act(async () => render());
      if (surface === "compact") {
        expect(document.querySelector('[data-testid="composer-model-picker"] [role="switch"]')).toBeNull();
        expect(document.querySelector('[data-testid="composer-model-picker"]')?.textContent).not.toContain("Fast mode");
      }
      await openSettings();
      expect(settings()?.textContent).not.toContain("Fast");
      expect(settings()?.textContent).not.toContain("higher pricing");
    } finally {
      await act(async () => root.unmount());
      host.remove(); queryClient.clear(); policySpy.mockRestore(); authSpy.mockRestore();
    }
  });
}

test("Fast Default and custom effort persist in the same session variant read by queued sends", async () => {
  const { getSessionModelSelection, useSessionModelStore } = await import("../src/react-app/domains/session/surface/session-model-store");
  const { setQueuedSendContext, getQueuedSendContext, clearQueuedSendContext } = await import("../src/react-app/domains/session/sync/queued-send-context");
  const { createOpenworkServerClient } = await import("../src/app/lib/openwork-server");
  const sessionId = "synthetic-fast-session";
  const model = { providerID: "fixture", modelID: "model" };
  const before = useSessionModelStore.getState().bySessionId;
  const stored = localStorage.getItem("openwork.sessionModels.v1");
  setQueuedSendContext(sessionId, { workspaceId: "fixture", workspaceRoot: "/fixture", opencodeBaseUrl: "http://synthetic.test/opencode2",
    openworkToken: "synthetic", client: createOpenworkServerClient({ baseUrl: "http://synthetic.test" }),
    agent: null, variant: "high", model, environmentRuntimeKey: null });
  try {
    useSessionModelStore.getState().setModel(sessionId, model, "high");
    for (const variant of [fastVariantId("CustomExact"), fastVariantId(null), null]) {
      useSessionModelStore.getState().setVariant(sessionId, variant);
      expect(getSessionModelSelection(sessionId)).toEqual({ model, variant });
      expect(localStorage.getItem("openwork.sessionModels.v1")).toContain(JSON.stringify({ model, variant }));
      // The drainer deliberately prefers session memory over its older context.
      expect(getQueuedSendContext(sessionId)?.variant).toBe("high");
    }
  } finally {
    clearQueuedSendContext(sessionId);
    useSessionModelStore.setState({ bySessionId: before });
    if (stored === null) localStorage.removeItem("openwork.sessionModels.v1");
    else localStorage.setItem("openwork.sessionModels.v1", stored);
  }
});

test("Automation preserves same-model settings, recovers Default and saves only on explicit submission", async () => {
  const { AutomationEditor } = await import("../src/react-app/domains/automations/automation-editor");
  const authSpy = spyOn(auth, "useDenAuth").mockReturnValue({ status: "signed_in", user: null, verifiedIdentity: { principalId: "fixture", organizationId: "fixture" }, isSignedIn: true, error: null, refresh: async () => undefined });
  const modelOptions: AutomationModelOption[] = ["first", "second"].map((modelId) => ({
    providerId: "lpr_fixture", modelId, providerName: "Fixture provider", modelName: modelId, accessKind: "authorized_custom",
  }));
  const catalog: AutomationProviderCatalog = { lpr_fixture: {} };
  for (const { modelId } of modelOptions) {
    catalog.lpr_fixture[modelId] = {
      id: modelId, providerID: "lpr_fixture", name: modelId,
      api: { id: modelId, url: "https://fixture.invalid", npm: "@ai-sdk/openai-compatible" },
      capabilities: { temperature: false, reasoning: true, attachment: false, toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 1, output: 1 },
      status: "active", options: {}, headers: {}, release_date: "2026-01-01",
      variants: modelId === "first" ? { low: {}, high: {} } : { low: {} },
    };
  }
  const initial: CreateAutomation = {
    name: "Saved instructions", instructions: "Keep these instructions unchanged.",
    schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
    model: { providerId: "lpr_fixture", modelId: "first", variant: "retired" },
  };
  let providerCatalog = catalog;
  const saved: CreateAutomation[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = () => root.render(createElement(PlatformProvider, { value: createDefaultPlatform(), children:
    createElement(AutomationEditor, { initial, initialKey: "revision-one", placement: "desktop", modelOptions,
      providerCatalog, busy: false, openModelPickerOnMount: true, submitLabel: "Save automation",
      onCancel: () => undefined, onSave: (input) => { saved.push(input); } }) }));
  const click = async (selector: string) => {
    const control = document.querySelector<HTMLElement>(selector);
    if (!control) throw new Error(`Missing Automation control: ${selector}`);
    await act(async () => control.click());
  };
  const effort = async (label: string) => {
    await openAdvanced();
    const control = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="current-model-settings"] button')).find((button) => button.textContent === label);
    if (!control) throw new Error(`Missing Automation effort: ${label}`);
    await act(async () => control.click());
    expect(document.querySelector('[data-testid="current-model-settings"] [aria-pressed="true"]')?.textContent).toBe(label);
    expect(saved).toEqual([]);
  };
  const selectModel = async (name: string) => {
    const control = Array.from(document.querySelectorAll<HTMLElement>('[data-model-key]')).find((row) => row.dataset.modelKey?.endsWith(`:${name}`));
    if (!control) throw new Error(`Missing model ${name}`);
    await act(async () => control.click());
  };
  try {
    await act(async () => render());
    await openAdvanced();
    expect(document.querySelector('[data-testid="current-model-settings"]')?.textContent).toContain('"retired" (not in current catalog)');
    await selectModel("first");
    expect(document.querySelector("#automation-model")?.textContent).toContain("retired");
    await click("#automation-model");
    await effort("Default");
    await effort("High");
    providerCatalog = {};
    await act(async () => render());
    expect(document.querySelector('[data-testid="current-model-settings"]')?.textContent).toContain('"high" (not in current catalog)');
    expect(document.querySelectorAll('[data-testid="current-model-settings"] button')).toHaveLength(1);
    await effort("Default");
    providerCatalog = catalog;
    await act(async () => render());
    await effort("High");
    await selectModel("second");
    await click("#automation-model");
    await openAdvanced();
    expect(document.querySelector('[data-testid="current-model-settings"] [aria-pressed="true"]')?.textContent).toBe("Default");
    expect(initial.model.variant).toBe("retired");
    expect(saved).toEqual([]);
    const done = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Done");
    if (!done) throw new Error("Missing Done button");
    await act(async () => done.click());
    await click('[data-automation-editor] button[type="submit"]');
    expect(saved).toEqual([{ ...initial, model: { providerId: "lpr_fixture", modelId: "second", variant: null } }]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    authSpy.mockRestore();
  }
});

test("long picker labels retain full hover text and select the complete model ID", async () => {
  const authSpy = spyOn(auth, "useDenAuth").mockReturnValue({ status: "signed_in", user: null, verifiedIdentity: { principalId: "fixture", organizationId: "fixture" }, isSignedIn: true, error: null, refresh: async () => undefined });
  const den = await import("../src/app/lib/den");
  const organization = "Synthetic organization with a very long display name";
  const settingsSpy = spyOn(den, "readDenSettings").mockReturnValue({ ...den.readDenSettings(), activeOrgName: organization });
  const providerID = "ipr_synthetic";
  const modelID = `gwm_${"synthetic_gateway_model_revision_".repeat(4)}`;
  const title = "Synthetic model with a long human-readable display name";
  const providerName = "Synthetic gateway provider with a long display name";
  const current = { providerID, modelID };
  const options: ModelOption[] = [{ ...current, title, description: providerName, source: "cloud", isRecommended: true, isFree: false }];
  const selected: unknown[] = [];
  const toggled: unknown[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Picker() {
    const [disabledProviders, setDisabledProviders] = useState<string[]>([]);
    return createElement(ModelPickerModal, { open: true, options, current, disabledProviders,
      target: "session", query: "", setQuery: () => undefined, gatewayProviderIds: new Set([providerID]),
      onSelect: (model) => selected.push(model), onBehaviorChange: () => undefined,
      onToggleProvider: (id, enabled) => { toggled.push({ id, enabled }); setDisabledProviders(enabled ? [] : [id]); },
      onOpenSettings: () => undefined, onClose: () => undefined });
  }
  const label = (text: string) => Array.from(document.querySelectorAll<HTMLElement>("[title]"))
    .find((element) => element.title === text);
  const toggle = async (text: string) => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent === text);
    if (!button) throw new Error(`Missing provider toggle: ${text}`);
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(createElement(PlatformProvider, { value: createDefaultPlatform(), children: createElement(Picker) })));
    expect(label(title)?.textContent).toBe(title);
    expect(document.querySelectorAll('[data-slot="badge"]')).toHaveLength(0);
    expect(document.querySelector("svg.lucide-cloud")).not.toBeNull();
    const modelButton = document.querySelector<HTMLElement>('[data-model-key]');
    expect(modelButton?.dataset.modelKey).toBe(`${providerID}:${modelID}`);
    if (!modelButton) throw new Error("Missing accessible gateway model");
    await act(async () => modelButton.click());
    expect(selected).toEqual([current]);
    expect(toggled).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    settingsSpy.mockRestore();
    authSpy.mockRestore();
  }
});

describe("model picker source provenance", () => {
  const importedCloudProviders = {
    ipr_gateway: { providerId: "ipr_gateway", source: "openwork_gateway" },
    lpr_team: { providerId: "lpr_team", source: "custom" },
  };

  test("treats inference gateway rows as cloud-managed provider keys", () => {
    expect(isCloudManagedProviderKey("ipr_gateway")).toBe(true);
    expect(isCloudManagedProviderKey("lpr_team")).toBe(true);
    expect(isCloudManagedProviderKey("anthropic")).toBe(false);
  });

  test("identifies only providers whose sync status source is the OpenWork gateway", () => {
    const gatewayProviderIds = resolveGatewayProviderIds(importedCloudProviders);
    expect([...gatewayProviderIds]).toEqual(["ipr_gateway"]);

    expect(gatewayProviderIds.has("lpr_team")).toBe(false);
  });
});

test("Auto remains checked while recovery focuses an alternative pin, and immutable pins have no toggle", async () => {
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { ModelPickerList } = await import("../src/react-app/domains/models/model-picker-list");
  const { AUTO_MODEL_ID, AUTO_PROVIDER_ID } = await import("../src/react-app/domains/models/model-catalog");
  const { useModelCollectionsStore } = await import("../src/react-app/domains/session/models/model-collections-store");
  const { autoAccessStatusQueryKey } = await import("../src/react-app/domains/cloud/auto-access-ui");
  const { unavailableDesktopFreeStatus } = await import("../src/app/lib/inference-access");
  const signedOut: ReturnType<typeof auth.useDenAuth> = { status: "signed_out", user: null, verifiedIdentity: null, isSignedIn: false, error: null, refresh: async () => undefined };
  const authSpy = spyOn(auth, "useDenAuth").mockReturnValue(signedOut);
  const current = { providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID };
  const base = { behaviorTitle: "Effort", behaviorLabel: "Default", behaviorDescription: "", behaviorValue: null, isFree: false };
  const auto = { ...base, ...current, title: "Luna" };
  const alternative = { ...base, providerID: "openai", modelID: "alternative", title: "Alternative" };
  const org = { ...base, providerID: "ipr_team", modelID: "gwm_team", title: "Team model", description: "Anthropic", organizationPinOrder: 0 };
  const previous = useModelCollectionsStore.getState();
  useModelCollectionsStore.setState({ favorites: [alternative], recent: [] });
  const selected: unknown[] = [];
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const queryClient = new QueryClient();
  try {
    await act(async () => root.render(createElement(PlatformProvider, { value: createDefaultPlatform(), children:
      createElement(QueryClientProvider, { client: queryClient, children: createElement(ModelPickerList, {
        options: [auto, alternative, org], current, query: "", onQueryChange: () => undefined,
        onSelect: (model) => selected.push(model), focusAlternative: true,
      }) }) })));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(document.querySelector(`[data-model-key="${AUTO_PROVIDER_ID}:${AUTO_MODEL_ID}"]`)?.getAttribute("data-checked")).toBe("true");
    expect(document.activeElement?.getAttribute("data-model-key")).toBe("ipr_team:gwm_team");
    expect(document.querySelector('button[aria-label="Unpin: Auto"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Unpin: Team model"]')).toBeNull();
    expect(host.textContent).toContain("Free · OpenWork picks the model");
    expect(host.querySelector("svg.lucide-star")).toBeNull();
    const autoRow = () => host.querySelector<HTMLElement>(`[data-model-key="${AUTO_PROVIDER_ID}:${AUTO_MODEL_ID}"]`);
    const orgRow = host.querySelector<HTMLElement>('[data-model-key="ipr_team:gwm_team"]');
    for (const row of host.querySelectorAll('[data-model-key]')) {
      expect(row.firstElementChild?.getAttribute("data-slot")).toBe("model-provider-mark");
      expect(row.lastElementChild?.getAttribute("data-slot")).toBe("model-selection");
      expect(row.lastElementChild?.previousElementSibling?.getAttribute("data-slot")).toBe("model-source");
    }
    expect(autoRow()?.querySelector('[data-slot="model-provider-mark"] svg.lucide-sparkles')).toBeNull();
    expect(autoRow()?.querySelector('[data-slot="model-provider-mark"] img[alt="OpenWork"]')).not.toBeNull();
    expect(autoRow()?.querySelector('[data-slot="model-source"] svg.lucide-cloud')).not.toBeNull();
    expect(orgRow?.querySelector('[data-slot="model-provider-mark"] svg')).not.toBeNull();
    expect(orgRow?.querySelector('[data-slot="model-provider-mark"] svg.lucide-cloud')).toBeNull();
    expect(orgRow?.textContent).toContain("Anthropic · pinned by your org");
    expect(orgRow?.textContent).not.toContain("OpenWork Gateway");
    expect(orgRow?.querySelector('[data-slot="model-selection"]')?.childElementCount).toBe(0);
    const statusKey = autoAccessStatusQueryKey(signedOut);
    expect(queryClient.getQueryState(statusKey)).toBeUndefined();
    await act(async () => queryClient.setQueryData(statusKey, { ...unavailableDesktopFreeStatus(), state: "exhausted" }));
    expect(autoRow()?.textContent).toContain("Free limit used up · resets Monday");
    expect(autoRow()?.getAttribute("data-checked")).toBe("true");
    await act(async () => queryClient.setQueryData(statusKey, { ...unavailableDesktopFreeStatus(), state: "exhausted", providerID: "another-provider" }));
    expect(autoRow()?.textContent).toContain("Free · OpenWork picks the model");
    await act(async () => queryClient.setQueryData(statusKey, { ...unavailableDesktopFreeStatus(), state: "ready", minimumVersion: "1.0.0",
      allowance: { limitUsd: 1, usedUsd: 1, reservedUsd: 0, remainingUsd: 0, resetsAt: "2026-09-28T00:00:00Z" } }));
    expect(autoRow()?.textContent).toContain("Free · OpenWork picks the model");
    expect(queryClient.getQueryState(statusKey)?.fetchStatus).toBe("idle");
    expect(selected).toEqual([]);
    const row = document.querySelector<HTMLElement>('[data-model-key="openai:alternative"]');
    await act(async () => { row?.focus(); row?.dispatchEvent(new KeyboardEvent("keydown", { key: "P", shiftKey: true, bubbles: true })); });
    expect(useModelCollectionsStore.getState().favorites).toEqual([]);
    expect(selected).toEqual([]);
  } finally {
    await act(async () => root.unmount()); host.remove(); queryClient.clear(); authSpy.mockRestore();
    useModelCollectionsStore.setState({ favorites: previous.favorites, recent: previous.recent });
  }
});

describe("gateway member sign-in", () => {
  const skipped = {
    ipr_member: {
      cloudProviderId: "ipr_member",
      providerId: "ipr_member",
      name: "Member Vertex",
      reason: "member_auth_required",
      authUrl: "https://den.example.test/v1/inference-providers/ipr_member/oauth/start",
    },
    ipr_org: { cloudProviderId: "ipr_org", providerId: "ipr_org", name: "Org Anthropic", reason: "org_credential_missing", authUrl: null },
    lpr_team: { cloudProviderId: "lpr_team", providerId: "lpr_team", name: "Team", reason: "missing_credentials" },
  };

  test("surfaces only member_auth_required skips as Connect rows with the sign-in copy", () => {
    const rows = resolveGatewayConnectProviders(skipped);
    expect(rows).toEqual([{
      cloudProviderId: "ipr_member",
      providerId: "ipr_member",
      name: "Member Vertex",
      authUrl: "https://den.example.test/v1/inference-providers/ipr_member/oauth/start",
    }]);
    expect(gatewayConnectCopy(rows[0]!.name)).toBe("Sign in to Member Vertex to use it");
    expect(resolveGatewayConnectProviders(undefined)).toEqual([]);
  });

  test("Connect opens the authenticated start result, then re-syncs until the provider is no longer skipped", async () => {
    const opened: string[] = [];
    const started: Array<[string, string | undefined]> = [];
    let syncs = 0;
    const waits: number[] = [];
    const connected = await connectGatewayProvider({
      provider: { ...resolveGatewayConnectProviders(skipped)[0]!, credentialSetId: "gcs_member" },
      signal: new AbortController().signal,
      startOAuth: async (providerId, credentialSetId) => {
        started.push([providerId, credentialSetId]);
        return { authorizationUrl: "https://oauth.example.test/authorize?state=test" };
      },
      openUrl: (url) => { opened.push(url); },
      resync: async () => { syncs += 1; },
      isConnected: () => syncs >= 3,
      wait: async (ms) => { waits.push(ms); },
      pollIntervalMs: 10_000,
      attempts: 6,
    });
    expect(started).toEqual([["ipr_member", "gcs_member"]]);
    expect(opened).toEqual(["https://oauth.example.test/authorize?state=test"]);
    expect(connected).toBe(true);
    expect(syncs).toBe(3);
    expect(waits).toEqual([10_000, 10_000, 10_000]);
  });

  test("Connect gives up after the poll budget and never opens a browser when authenticated start fails", async () => {
    const opened: string[] = [];
    let syncs = 0;
    const provider = resolveGatewayConnectProviders(skipped)[0]!;
    expect(await connectGatewayProvider({
      provider,
      signal: new AbortController().signal,
      startOAuth: async () => ({ authorizationUrl: "https://oauth.example.test/authorize?state=test" }),
      openUrl: (url) => { opened.push(url); },
      resync: async () => { syncs += 1; throw new Error("den offline"); },
      isConnected: () => false,
      wait: async () => undefined,
      attempts: 2,
    })).toBe(false);
    expect(syncs).toBe(2);
    expect(opened).toHaveLength(1);

    await expect(connectGatewayProvider({
      provider,
      signal: new AbortController().signal,
      startOAuth: async () => { throw new Error("OAuth start denied"); },
      openUrl: (url) => { opened.push(url); },
      resync: async () => { syncs += 1; },
      isConnected: () => true,
    })).rejects.toThrow("OAuth start denied");
    expect(opened).toHaveLength(1);
    expect(syncs).toBe(2);
  });

  test.each(["before-start", "during-start", "during-wait"])("Connect respects cancellation %s", async (phase) => {
    const controller = new AbortController();
    const opened: string[] = [];
    let starts = 0;
    let syncs = 0;
    if (phase === "before-start") controller.abort();
    const connected = await connectGatewayProvider({
      provider: resolveGatewayConnectProviders(skipped)[0]!,
      signal: controller.signal,
      startOAuth: async () => {
        starts += 1;
        if (phase === "during-start") controller.abort();
        return { authorizationUrl: "https://oauth.example.test/authorize?state=test" };
      },
      openUrl: (url) => { opened.push(url); },
      wait: async () => { controller.abort(); },
      resync: async () => { syncs += 1; },
      isConnected: () => true,
    });
    expect(connected).toBe(false);
    expect(starts).toBe(phase === "before-start" ? 0 : 1);
    expect(opened).toHaveLength(phase === "during-wait" ? 1 : 0);
    expect(syncs).toBe(0);
  });
});
