import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import type { ModelOption, ModelRef } from "../src/app/types";
import { MODEL_PREF_KEY } from "../src/app/constants";

GlobalRegistrator.register({ url: "http://localhost" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ModelPickerList } = await import("../src/react-app/domains/models/model-picker-list");
const { ModelPickerModal } = await import("../src/react-app/domains/session/modals/model-picker-modal");
const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform");
const auth = await import("../src/react-app/domains/cloud/den-auth-provider");
const policy = await import("../src/react-app/domains/cloud/desktop-config-provider");
const { autoAccessStatusQueryKey } = await import("../src/react-app/domains/cloud/auto-access-ui");
const { unavailableDesktopFreeStatus } = await import("../src/app/lib/inference-access");
const { AUTO_MODEL_ID, AUTO_PROVIDER_ID } = await import("../src/react-app/domains/models/model-catalog");
const { useModelCollectionsStore } = await import("../src/react-app/domains/session/models/model-collections-store");
const signedOut: ReturnType<typeof auth.useDenAuth> = { status: "signed_out", user: null, verifiedIdentity: null, isSignedIn: false, error: null, refresh: async () => {} };
let restoreAuth = () => {};
let restorePolicy = () => {};
beforeEach(() => {
  const authSpy = spyOn(auth, "useDenAuth").mockReturnValue(signedOut);
  const policySpy = spyOn(policy, "useCheckDesktopRestriction").mockReturnValue(() => false);
  restoreAuth = () => authSpy.mockRestore(); restorePolicy = () => policySpy.mockRestore();
  useModelCollectionsStore.setState({ favorites: [], recent: [] });
  window.location.hash = "";
});
afterEach(() => { restoreAuth(); restorePolicy(); });
afterAll(async () => GlobalRegistrator.unregister());
const option = (providerID: string, modelID: string, title = modelID): ModelOption => ({ providerID, modelID, title, description: "Fixture provider", isFree: false,
  behaviorTitle: "Effort", behaviorLabel: "Default", behaviorDescription: "", behaviorValue: null });
const auto = option(AUTO_PROVIDER_ID, AUTO_MODEL_ID, "Auto");
const local = option("openai", "local", "Local model");
const noModel = { providerID: "", modelID: "" };

async function fixture() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const render = async (content: React.ReactNode, platform = createDefaultPlatform()) => act(async () => root.render(
    <PlatformProvider value={platform}><QueryClientProvider client={client}>{content}</QueryClientProvider></PlatformProvider>,
  ));
  const click = async (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
    if (!button) throw new Error(`Missing action: ${label}`);
    await act(async () => button.click());
  };
  const finish = async () => { await act(async () => root.unmount()); host.remove(); client.clear(); };
  return { client, host, render, click, finish };
}

test("initial loading uses row skeletons, then empty search names the query and clears without selecting", async () => {
  const view = await fixture();
  const selections: ModelRef[] = [];
  try {
    await view.render(<ModelPickerList options={[]} current={noModel} query="" onQueryChange={() => {}} onSelect={(model) => selections.push(model)} catalogState={{ state: "loading" }} />);
    expect(document.querySelector('[aria-label="Loading models"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-model-key]')).toHaveLength(0);
    expect(view.host.textContent).not.toContain("No models yet");
    function EmptySearch() {
      const [query, setQuery] = useState("atlas");
      return <ModelPickerList options={[local]} current={local} query={query} onQueryChange={setQuery} onSelect={(model) => selections.push(model)} />;
    }
    await view.render(<EmptySearch />);
    expect(view.host.textContent).toContain("No models match “atlas”");
    await view.click("Clear search");
    expect(document.querySelector('[data-model-key="openai:local"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search all models");
    expect(selections).toEqual([]);
  } finally { await view.finish(); }
});

test("catalog failure keeps cached pins usable, reports last verified time, and Retry never selects", async () => {
  const view = await fixture();
  const selections: ModelRef[] = [];
  const retry = Promise.withResolvers<void>();
  let retries = 0;
  const at = Date.parse("2026-09-21T10:42:00Z");
  useModelCollectionsStore.setState({ favorites: [local] });
  try {
    await view.render(<ModelPickerList options={[local]} current={local} query="" onQueryChange={() => {}} onSelect={(model) => selections.push(model)}
      catalogState={{ state: "error", lastVerifiedAt: at, onRetry: () => { retries++; return retry.promise; } }} />);
    expect(document.querySelector("time")?.dateTime).toBe(new Date(at).toISOString());
    expect(view.host.textContent).toContain("availability not verified");
    await view.click("Retry");
    expect(retries).toBe(1);
    expect(selections).toEqual([]);
    expect([...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Retry")?.disabled).toBe(true);
    await act(async () => retry.resolve());
    await act(async () => document.querySelector<HTMLElement>('[data-model-key="openai:local"]')?.click());
    expect(selections).toHaveLength(1);
    expect(retries).toBe(1);
  } finally { await view.finish(); }
});

test("catalog failure without cached models offers Retry rather than claiming no models are connected", async () => {
  const view = await fixture();
  let retries = 0; let selections = 0;
  try {
    await view.render(<ModelPickerList options={[]} current={noModel} query="" onQueryChange={() => {}} onSelect={() => { selections++; }} catalogState={{ state: "error", onRetry: () => { retries++; } }} />);
    expect(view.host.textContent).toContain("Couldn’t load your models");
    expect(view.host.textContent).not.toContain("No models yet");
    await view.click("Retry");
    expect(retries).toBe(1); expect(selections).toBe(0);
  } finally { await view.finish(); }
});

test("saved-unavailable selection stays checked but cannot be selected or made default", async () => {
  const view = await fixture();
  const selected = option("openai", "removed", "Saved model name");
  const selections: ModelRef[] = [];
  let defaults = 0;
  let refreshes = 0;
  try {
    await view.render(<ModelPickerList options={[local]} current={selected} query="" onQueryChange={() => {}} onSelect={(model) => selections.push(model)} onSetWorkspaceDefault={() => { defaults++; }}
      retainedSelection={{ model: selected, title: selected.title, reason: "unavailable" }} catalogState={{ state: "ready", onRetry: () => { refreshes++; } }} />);
    const retained = document.querySelector<HTMLElement>('[data-testid="retained-selected-model"]');
    expect(retained?.getAttribute("aria-disabled")).toBe("true");
    expect(retained?.textContent).toContain("no longer available here");
    expect(retained?.querySelector("svg.lucide-check")).not.toBeNull();
    await act(async () => retained?.click());
    await view.click("Refresh");
    expect(selections).toEqual([]); expect(defaults).toBe(0); expect(refreshes).toBe(1);
  } finally { await view.finish(); }
});

test("policy blocks only reveal the selected saved row, name the organization owner, and never grant a model", async () => {
  const view = await fixture();
  const current = option("openai", "saved", "Saved personal model");
  const hidden = option("anthropic", "hidden", "Unrelated blocked model");
  const allowed = option("lpr_team", "allowed", "Team model");
  const signedIn = spyOn(auth, "useDenAuth").mockReturnValue({ ...signedOut, status: "signed_in", isSignedIn: true, verifiedIdentity: { principalId: "fixture", organizationId: "fixture" } });
  const selections: ModelRef[] = [];
  try {
    await view.render(<ModelPickerModal open current={current} options={[current, hidden, allowed]} restrictToCloud target="session" query="" setQuery={() => {}}
      onSelect={(model) => selections.push(model)} onBehaviorChange={() => {}} onOpenSettings={() => {}} onClose={() => {}} />);
    expect(document.body.textContent).toContain("blocked by your organization");
    expect(document.body.textContent).toContain("workspace owner or admin");
    expect(document.body.textContent).not.toContain("Unrelated blocked model");
    expect(document.querySelector('[data-model-key="openai:saved"]')).toBeNull();
    await act(async () => document.querySelector<HTMLElement>('[data-testid="retained-selected-model"]')?.click());
    expect(selections).toEqual([]);
    await act(async () => document.querySelector<HTMLElement>('[data-model-key="lpr_team:allowed"]')?.click());
    expect(selections).toEqual([{ providerID: allowed.providerID, modelID: allowed.modelID }]);
  } finally { await view.finish(); signedIn.mockRestore(); }
});

test("disabled saved providers open settings without enabling or selecting, and signed-out cloud names stay hidden", async () => {
  const view = await fixture();
  let settings = 0; let selections = 0; let toggles = 0;
  try {
    await view.render(<ModelPickerModal open current={local} options={[local]} disabledProviders={[local.providerID]} target="session" query="" setQuery={() => {}}
      onSelect={() => { selections++; }} onToggleProvider={() => { toggles++; }} onBehaviorChange={() => {}} onOpenSettings={() => {}} onOpenProviderSettings={() => { settings++; }} onClose={() => {}} />);
    expect(document.body.textContent).toContain("disabled in AI providers");
    await view.click("AI providers");
    expect([settings, selections, toggles]).toEqual([1, 0, 0]);
    const cloud = option("ipr_private", "gwm_private", "Previous account private model");
    await view.render(<ModelPickerModal open current={cloud} options={[cloud]} target="session" query="" setQuery={() => {}}
      onSelect={() => { selections++; }} onBehaviorChange={() => {}} onOpenSettings={() => {}} onClose={() => {}} />);
    expect(document.body.textContent).not.toContain("Previous account private model");
    expect(document.body.textContent).toContain("sign in to verify access");
    expect(document.querySelector('[data-model-key="ipr_private:gwm_private"]')).toBeNull();
    expect(document.querySelector('[data-testid="retained-selected-model"] img')).toBeNull();
    expect(selections).toBe(0);
  } finally { await view.finish(); }
});

test("zero connected models offers connect or settings without creating Auto or selecting anything", async () => {
  const view = await fixture();
  let connects = 0; let settings = 0; let selections = 0;
  try {
    await view.render(<ModelPickerList options={[]} current={noModel} query="" onQueryChange={() => {}} onSelect={() => { selections++; }} onConnectProvider={() => { connects++; }} onOpenProviderSettings={() => { settings++; }} catalogState={{ state: "ready" }} />);
    expect(view.host.textContent).toContain("No models yet");
    expect(view.host.textContent).toContain("turn Auto back on in AI providers");
    expect(document.querySelectorAll('[data-model-key]')).toHaveLength(0);
    await view.click("Connect a provider"); await view.click("AI providers");
    expect([connects, settings, selections]).toEqual([1, 1, 0]);
  } finally { await view.finish(); }
});

for (const state of ["exhausted", "update_required", "unavailable", "sync"] as const) {
  test(`Auto ${state} retains the checked row and recovery action without selecting or sending`, async () => {
    const view = await fixture();
    let selections = 0; let retries = 0; let reloads = 0;
    if (state !== "sync") view.client.setQueryData(autoAccessStatusQueryKey(signedOut), { ...unavailableDesktopFreeStatus(), state });
    try {
      await view.render(<ModelPickerList options={[auto, local]} current={auto} query="" onQueryChange={() => {}} onSelect={() => { selections++; }}
        openWorkModelsSyncing={state === "sync"} onRetryAuto={() => { retries++; }} onReloadWorkspace={() => { reloads++; }} />);
      const row = document.querySelector<HTMLElement>(`[data-model-key="${AUTO_PROVIDER_ID}:${AUTO_MODEL_ID}"]`);
      expect(row?.getAttribute("data-checked")).toBe("true");
      expect(row?.getAttribute("aria-disabled")).toBe("true");
      await act(async () => row?.click());
      if (state === "exhausted") { await view.click("Sign in"); expect(window.location.hash).toContain("settings/cloud-account"); }
      if (state === "update_required") { await view.click("Update"); expect(window.location.hash).toContain("settings/updates"); }
      if (state === "unavailable") { await view.click("Retry"); expect(retries).toBe(1); }
      if (state === "sync") { await view.click("Reload"); expect(reloads).toBe(1); }
      expect(selections).toBe(0);
      expect(view.host.textContent).not.toMatch(/USD|\$|Upgrade/);
    } finally { await view.finish(); }
  });
}

test("exhausted Auto without alternatives focuses search and offers Connect", async () => {
  const view = await fixture();
  let connects = 0; let selections = 0;
  view.client.setQueryData(autoAccessStatusQueryKey(signedOut), { ...unavailableDesktopFreeStatus(), state: "exhausted" });
  try {
    await view.render(<ModelPickerList options={[auto]} current={auto} query="" onQueryChange={() => {}} onSelect={() => { selections++; }} focusAlternative onConnectProvider={() => { connects++; }} />);
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search all models");
    expect(view.host.textContent).toContain("Nothing else is connected in this workspace");
    await view.click("Connect a provider");
    expect(connects).toBe(1); expect(selections).toBe(0);
  } finally { await view.finish(); }
});

test("a real defaultPinned false status removes only the automatic Auto pin and keeps Auto accessible", async () => {
  const view = await fixture();
  view.client.setQueryData(autoAccessStatusQueryKey(signedOut), { ...unavailableDesktopFreeStatus(), state: "ready", defaultPinned: false, minimumVersion: "1.0.0",
    allowance: { limitUsd: 1, usedUsd: 0, reservedUsd: 0, remainingUsd: 1, resetsAt: "2026-09-28T00:00:00Z" } });
  let selections = 0;
  try {
    await view.render(<ModelPickerList options={[auto, local]} current={local} query="" onQueryChange={() => {}} onSelect={() => { selections++; }} />);
    expect([...view.host.querySelectorAll('[data-slot="command-group-label"]')].map((node) => node.textContent)).not.toContain("Pinned");
    expect(view.host.querySelector(`[data-model-key="${AUTO_PROVIDER_ID}:${AUTO_MODEL_ID}"]`)).not.toBeNull();
    expect(view.host.querySelector('[aria-label="Pin to top: Auto"]')).not.toBeNull();
    expect(selections).toBe(0);
  } finally { await view.finish(); }
});

test("workspace-default context action delegates only to its supplied workspace setter", async () => {
  const view = await fixture();
  const defaults: ModelRef[] = [];
  let selections = 0;
  localStorage.setItem(MODEL_PREF_KEY, "global-unchanged");
  const before = localStorage.getItem(MODEL_PREF_KEY);
  const platform = { ...createDefaultPlatform(), showContextMenu: async () => "default" };
  try {
    await view.render(<ModelPickerList options={[local]} current={local} query="" onQueryChange={() => {}} onSelect={() => { selections++; }} onSetWorkspaceDefault={(model) => { defaults.push(model); return true; }} />, platform);
    await act(async () => document.querySelector<HTMLElement>('[data-model-key="openai:local"]')?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    expect(defaults).toHaveLength(1); expect(defaults[0].modelID).toBe(local.modelID);
    expect(localStorage.getItem(MODEL_PREF_KEY)).toBe(before);
    expect(selections).toBe(0);
  } finally { await view.finish(); }
});
