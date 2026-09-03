import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, useState } from "react";
import type { CreateAutomation } from "@openwork/types/automations";
import type { AutomationProviderCatalog, AutomationModelOption } from "../src/react-app/domains/automations/automation-model-options";
import type { ModelOption } from "../src/app/types";

// Base UI detects DOM support when its module loads.
GlobalRegistrator.register({ url: "http://localhost" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => { await GlobalRegistrator.unregister(); });
const { createRoot } = await import("react-dom/client");
const auth = await import("../src/react-app/domains/cloud/den-auth-provider");
const { createDefaultPlatform, PlatformProvider } = await import("../src/react-app/kernel/platform");
const { ModelPickerModal, MODEL_PICKER_DEFAULT_SUBTITLE, MODEL_PICKER_UNAVAILABLE_SUBTITLE, resolveModelPickerSubtitle, resolveProviderGroupBadges } = await import("../src/react-app/domains/session/modals/model-picker-modal");
import {
  connectGatewayProvider,
  gatewayConnectCopy,
  isCloudManagedProviderKey,
  resolveGatewayConnectProviders,
  resolveGatewayProviderIds,
} from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";

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
  const effortButton = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="model-select-root"] button'))
    .find((button) => button.textContent?.includes("Effort"));
  try {
    await act(async () => render());
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

test("Automation preserves same-model settings, recovers Default and saves only on explicit submission", async () => {
  const { AutomationEditor } = await import("../src/react-app/domains/automations/automation-editor");
  const authSpy = spyOn(auth, "useDenAuth").mockReturnValue({ status: "signed_out", user: null, verifiedIdentity: null, isSignedIn: false, error: null, refresh: async () => undefined });
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
    const control = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="current-model-settings"] button')).find((button) => button.textContent === label);
    if (!control) throw new Error(`Missing Automation effort: ${label}`);
    await act(async () => control.click());
    expect(document.querySelector('[data-testid="current-model-settings"] [aria-pressed="true"]')?.textContent).toBe(label);
    expect(saved).toEqual([]);
  };
  const selectModel = async (name: string) => {
    const control = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === `${name}${name}`);
    if (!control) throw new Error(`Missing model ${name}`);
    await act(async () => control.click());
  };
  try {
    await act(async () => render());
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

describe("model picker provider badges", () => {
  const importedCloudProviders = {
    ipr_gateway: { providerId: "ipr_gateway", source: "openwork_gateway" },
    lpr_team: { providerId: "lpr_team", source: "custom" },
  };
  const labels = (group: Parameters<typeof resolveProviderGroupBadges>[0]) =>
    resolveProviderGroupBadges(group, "Acme").map((badge) => badge.label);

  test("treats inference gateway rows as cloud-managed provider keys", () => {
    expect(isCloudManagedProviderKey("ipr_gateway")).toBe(true);
    expect(isCloudManagedProviderKey("lpr_team")).toBe(true);
    expect(isCloudManagedProviderKey("anthropic")).toBe(false);
  });

  test("badges only providers whose sync status source is the OpenWork gateway", () => {
    const gatewayProviderIds = resolveGatewayProviderIds(importedCloudProviders);
    expect([...gatewayProviderIds]).toEqual(["ipr_gateway"]);

    const gateway = labels({
      isNew: false,
      isCloud: true,
      isGateway: gatewayProviderIds.has("ipr_gateway"),
      hasCurrent: false,
    });
    expect(gateway).toEqual(["Acme", "via OpenWork Gateway"]);

    const organization = labels({
      isNew: false,
      isCloud: true,
      isGateway: gatewayProviderIds.has("lpr_team"),
      hasCurrent: true,
    });
    expect(organization).toEqual(["Acme", "Current"]);
    expect(organization).not.toContain("via OpenWork Gateway");
  });
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

  test("Connect opens authUrl in the browser, then re-syncs until the provider is no longer skipped", async () => {
    const opened: string[] = [];
    let syncs = 0;
    const waits: number[] = [];
    const connected = await connectGatewayProvider({
      provider: resolveGatewayConnectProviders(skipped)[0]!,
      openUrl: (url) => { opened.push(url); },
      resync: async () => { syncs += 1; },
      isConnected: () => syncs >= 3,
      wait: async (ms) => { waits.push(ms); },
      pollIntervalMs: 10_000,
      attempts: 6,
    });
    expect(opened).toEqual(["https://den.example.test/v1/inference-providers/ipr_member/oauth/start"]);
    expect(connected).toBe(true);
    expect(syncs).toBe(3);
    expect(waits).toEqual([10_000, 10_000, 10_000]);
  });

  test("Connect gives up after the poll budget and never opens a browser without an authUrl", async () => {
    const opened: string[] = [];
    let syncs = 0;
    const provider = resolveGatewayConnectProviders(skipped)[0]!;
    expect(await connectGatewayProvider({
      provider,
      openUrl: (url) => { opened.push(url); },
      resync: async () => { syncs += 1; throw new Error("den offline"); },
      isConnected: () => false,
      wait: async () => undefined,
      attempts: 2,
    })).toBe(false);
    expect(syncs).toBe(2);
    expect(opened).toHaveLength(1);

    expect(await connectGatewayProvider({
      provider: { ...provider, authUrl: null },
      openUrl: (url) => { opened.push(url); },
      resync: async () => { syncs += 1; },
      isConnected: () => true,
    })).toBe(false);
    expect(opened).toHaveLength(1);
    expect(syncs).toBe(2);
  });
});
