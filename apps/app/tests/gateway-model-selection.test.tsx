import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createRef, useState } from "react";
import { hasPendingGatewayModelSelection } from "../src/react-app/domains/connections/provider-auth/pending-gateway-model-selection";
import type { GatewayModelSelectionHandle } from "../src/react-app/domains/connections/provider-auth/gateway-model-access";
import { markDisabledModelOptions } from "../src/react-app/domains/connections/provider-auth/assigned-model-options";
import { captureFavoriteModelTarget, isFavoriteModelTargetCurrent } from "../src/react-app/shell/favorite-model-shortcut";
import type { WorkbenchSnapshot } from "../src/react-app/domains/session/chat/workbench-store";
import type { GatewayUsableModel } from "@openwork/types/den/gateway";
import type { ModelOption, ModelRef } from "../src/app/types";
import { connectGatewayProvider, isGatewayModelReady, pendingGatewayModelOptions, resolveGatewayConnectProviders, type GatewayConnectProvider } from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";
import { denSessionUpdatedEvent, denSettingsChangedEvent } from "../src/app/lib/den-session-events";

GlobalRegistrator.register({ url: "http://localhost" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
const { createRoot } = await import("react-dom/client");
const auth = await import("../src/react-app/domains/cloud/den-auth-provider");
const policy = await import("../src/react-app/domains/cloud/desktop-config-provider");
const { createDefaultPlatform, PlatformProvider } = await import("../src/react-app/kernel/platform");
const { GatewayModelAccessProvider } = await import("../src/react-app/domains/connections/provider-auth/gateway-model-access");
const { ModelPickerModal } = await import("../src/react-app/domains/session/modals/model-picker-modal");
const { ModelSelect } = await import("../src/components/model-select");
const { WorkspaceProvider } = await import("../src/react-app/shell/workspace-provider");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { useModelCollectionsStore } = await import("../src/react-app/domains/session/models/model-collections-store");
// Imported after the DOM exists: its module chain reads the DOM when it loads.
const { openModelPickerEvent } = await import("../src/react-app/shell/new-providers-listener");

afterAll(async () => { await GlobalRegistrator.unregister(); });

function pendingProvider(setSuffix: string, name: string): GatewayConnectProvider {
  const group = "00000000000000000000000001";
  const id = `gwm_${group}_${setSuffix}_00000000000000000000000003`;
  const model: GatewayUsableModel = {
    id, name, config: { id }, upstreamModelId: "same-upstream-model", modelGroupId: `gmg_${group}`,
    modelGroupName: "Assigned group", credentialSetId: `gcs_${setSuffix}`, credentialSetName: name,
  };
  return { cloudProviderId: "ipr_assigned", providerId: "ipr_assigned", credentialSetId: model.credentialSetId,
    name: `Assigned provider / ${name}`, authUrl: "https://legacy.example.test/never-open", models: [model] };
}
const providers = [pendingProvider("00000000000000000000000002", "Personal"), pendingProvider("00000000000000000000000004", "Work")];
const options = pendingGatewayModelOptions(providers);
const original: ModelRef = { providerID: "local", modelID: "current" };
const localOption: ModelOption = { ...original, title: "Current model", description: "Local", behaviorTitle: "Reasoning",
  behaviorLabel: "Default", behaviorValue: null, behaviorDescription: "", isFree: false };
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let authSpy: ReturnType<typeof spyOn>;
let policySpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  authSpy = spyOn(auth, "useDenAuth").mockReturnValue({ status: "signed_in", user: null, verifiedIdentity: null, isSignedIn: true, error: null, refresh: async () => undefined });
  policySpy = spyOn(policy, "useCheckDesktopRestriction").mockReturnValue(() => false);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  useModelCollectionsStore.setState({ favorites: [], recent: [] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  authSpy.mockRestore();
  policySpy.mockRestore();
  expect(hasPendingGatewayModelSelection()).toBe(false);
});

function button(text: string) {
  const result = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.textContent === text);
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
async function click(text: string) { await act(async () => button(text).click()); }
async function choose(name: string) {
  const title = Array.from(document.querySelectorAll<HTMLElement>("[title]")).find((node) => node.title === name);
  const control = title?.closest("button");
  if (!control) throw new Error(`Missing model: ${name}`);
  await act(async () => control.click());
}
function deferred() {
  let resolve: (ready: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  return { promise, resolve };
}

function picker(input: {
  login?: (provider: GatewayConnectProvider, signal: AbortSignal, model?: ModelRef) => Promise<boolean>;
  scope?: string;
  current?: ModelRef;
  assigned?: GatewayConnectProvider[];
  disabledProviders?: string[];
  onToggleProvider?: (providerId: string, enabled: boolean) => void;
  selected: ModelRef[];
}) {
  return <PlatformProvider value={createDefaultPlatform()}>
    <GatewayModelAccessProvider providers={input.assigned ?? providers} disabledProviders={input.disabledProviders} scopeKey={input.scope ?? "account/org/session"} login={input.login ?? (async () => true)}>
      <ModelPickerModal open options={markDisabledModelOptions([localOption, ...pendingGatewayModelOptions(input.assigned ?? providers)], input.disabledProviders ?? [])}
        disabledProviders={input.disabledProviders} onToggleProvider={input.onToggleProvider}
        current={input.current ?? original} target="session" query="" setQuery={() => undefined}
        gatewayConnectProviders={input.assigned ?? providers} onSelect={(model) => input.selected.push(model)}
        onBehaviorChange={() => { throw new Error("Pending model must not edit effort"); }} onOpenSettings={() => undefined} onClose={() => undefined} />
    </GatewayModelAccessProvider>
  </PlatformProvider>;
}

test("only assigned member-auth models are offered; missing org credentials and unassigned catalog models stay hidden", () => {
  const rows = resolveGatewayConnectProviders({
    allowed: { ...providers[0]!, reason: "member_auth_required" },
    noGrant: { ...providers[1]!, reason: "no_accessible_models" },
    orgMissing: { ...providers[1]!, reason: "org_credential_missing" },
    apiKey: { ...providers[1]!, reason: "needs_key" },
  });
  expect(pendingGatewayModelOptions(rows).map((model) => model.modelID)).toEqual([options[0]!.modelID]);
  expect(pendingGatewayModelOptions([{ ...providers[0]!, models: undefined }])).toEqual([]);
  expect(pendingGatewayModelOptions([{ ...providers[0]!, credentialSetId: providers[1]!.credentialSetId }])).toEqual([]);
});

test("a model that needs sign-in starts it right on its group; Cancel leaves the current model", async () => {
  const selected: ModelRef[] = [];
  const result = deferred();
  let signal: AbortSignal | undefined;
  await act(async () => root.render(picker({ selected, login: async (_provider, nextSignal) => { signal = nextSignal; return result.promise; } })));
  expect(document.body.textContent).toContain("Sign in with Assigned provider / Personal");
  expect(document.body.textContent).not.toContain("Log in to this provider to use the models");
  expect(document.body.textContent).not.toContain("via OpenWork Gateway");
  await choose("Personal");
  expect(document.body.textContent).toContain("Finish signing in in your browser");
  expect(selected).toEqual([]);
  await click("Cancel");
  expect(signal?.aborted).toBe(true);
  await act(async () => { result.resolve(true); await result.promise; });
  expect(selected).toEqual([]);
  expect(document.body.textContent).not.toContain("Finish signing in in your browser");
});

test("the group's Sign in unlocks it without changing the current model", async () => {
  const selected: ModelRef[] = [];
  const models: Array<ModelRef | undefined> = [];
  await act(async () => root.render(picker({ selected, login: async (_provider, _signal, model) => { models.push(model); return true; } })));
  await click("Sign in with Assigned provider / Personal");
  expect(models).toEqual([undefined]);
  expect(selected).toEqual([]);
});

test("Login uses the shared Settings OAuth helper with the selected credential set and applies only after sync", async () => {
  const selected: ModelRef[] = [];
  const started: Array<[string, string | undefined]> = [];
  const opened: string[] = [];
  const wait = deferred();
  let synced = false;
  const login = async (provider: GatewayConnectProvider, signal: AbortSignal, model?: ModelRef) => {
    expect(model?.modelID).toBe(options[1]!.modelID);
    return connectGatewayProvider({
      provider, signal,
      startOAuth: async (id, set) => { started.push([id, set]); return { authorizationUrl: "https://oauth.example.test/authoritative" }; },
      openUrl: (url) => { opened.push(url); }, wait: async () => { await wait.promise; }, attempts: 1,
      resync: async () => { synced = true; }, isConnected: () => synced,
    });
  };
  await act(async () => root.render(picker({ selected, login })));
  await choose("Work");
  expect(started).toEqual([[providers[1]!.cloudProviderId, providers[1]!.credentialSetId]]);
  expect(opened).toEqual(["https://oauth.example.test/authoritative"]);
  expect(selected).toEqual([]);
  await act(async () => { wait.resolve(true); await wait.promise; });
  expect(selected).toEqual([{ providerID: options[1]!.providerID, modelID: options[1]!.modelID }]);
});

test("first-org sync cannot repair the default before the explicit second alias is applied", async () => {
  const selected: ModelRef[] = [];
  const result = deferred();
  let repairAttempted = false;
  function FirstOrgPicker() {
    const [current, setCurrent] = useState(original);
    const [pending, setPending] = useState(providers);
    return <PlatformProvider value={createDefaultPlatform()}>
      <GatewayModelAccessProvider providers={pending} scopeKey={JSON.stringify(["org/session", current])} login={async () => {
        repairAttempted = true;
        if (!hasPendingGatewayModelSelection()) setCurrent(options[0]!);
        setPending([]);
        return result.promise;
      }}>
        <output data-current-model>{current.modelID}</output>
        <ModelPickerModal open options={[localOption, ...options]} current={current} target="session" query="" setQuery={() => undefined}
          onSelect={(model) => { selected.push(model); setCurrent(model); }} onBehaviorChange={() => undefined}
          onOpenSettings={() => undefined} onClose={() => undefined} />
      </GatewayModelAccessProvider>
    </PlatformProvider>;
  }
  await act(async () => root.render(<FirstOrgPicker />));
  await choose("Work");
  expect(repairAttempted).toBe(true);
  expect(host.querySelector("[data-current-model]")?.textContent).toBe(original.modelID);
  expect(selected).toEqual([]);
  await act(async () => { result.resolve(true); await result.promise; });
  expect(selected).toEqual([{ providerID: options[1]!.providerID, modelID: options[1]!.modelID }]);
  expect(host.querySelector("[data-current-model]")?.textContent).toBe(options[1]!.modelID);
  expect(hasPendingGatewayModelSelection()).toBe(false);
});

test.each(["cancel", "session", "model", "account", "organization", "unmount", "disabled"])("late login cannot change selection after %s", async (change) => {
  const selected: ModelRef[] = [];
  const result = deferred();
  let signal: AbortSignal | undefined;
  const login = async (_provider: GatewayConnectProvider, nextSignal: AbortSignal) => { signal = nextSignal; return result.promise; };
  await act(async () => root.render(picker({ selected, login })));
  await choose("Personal");
  if (change === "cancel") await click("Cancel");
  else if (change === "session") await act(async () => root.render(picker({ selected, login, scope: "account/org/other-session" })));
  else if (change === "model") await act(async () => root.render(picker({ selected, login, current: { providerID: "local", modelID: "other" } })));
  else if (change === "unmount") await act(async () => root.render(null));
  else if (change === "disabled") await act(async () => root.render(picker({ selected, login, disabledProviders: [providers[0]!.providerId] })));
  else await act(async () => {
    window.dispatchEvent(new Event(change === "account" ? denSessionUpdatedEvent : denSettingsChangedEvent));
    root.render(picker({ selected, login, assigned: [] }));
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => { result.resolve(true); await result.promise; });
  expect(selected).toEqual([]);
});

test("a sign-in that doesn't finish keeps the current model and offers Try again on the group", async () => {
  const selected: ModelRef[] = [];
  let starts = 0;
  await act(async () => root.render(picker({ selected, login: async () => { starts++; return false; } })));
  await choose("Personal");
  expect(selected).toEqual([]);
  expect(document.body.textContent).toContain("Sign-in didn't finish.");
  await click("Try again");
  expect(starts).toBe(2);
});

test("a sign-in that cannot start says why, in place", async () => {
  const selected: ModelRef[] = [];
  await act(async () => root.render(picker({ selected, login: async () => { throw new Error("Sign in from My Library › Models in OpenWork Cloud, then refresh models here."); } })));
  await choose("Personal");
  expect(document.body.textContent).toContain("Sign in from My Library › Models in OpenWork Cloud");
  expect(selected).toEqual([]);
});

test("exact alias readiness rejects a different set, deferred reload, pending skip and unverified sync", () => {
  const provider = providers[0]!;
  const model = options[0]!;
  const snapshot = {
    gatewayUsageProviderScope: 1,
    importedCloudProviders: { [provider.cloudProviderId]: {
      cloudProviderId: provider.cloudProviderId, providerId: provider.providerId, sourceProviderId: "google-vertex",
      name: "Assigned", source: "openwork_gateway", modelIds: [model.modelID], updatedAt: null, importedAt: 1,
    } },
    cloudProviderServerSync: { reloadPending: false, skippedProviders: {} },
  };
  expect(isGatewayModelReady(provider, model, snapshot)).toBe(true);
  expect(isGatewayModelReady(provider, options[1]!, snapshot)).toBe(false);
  expect(isGatewayModelReady(provider, model, { ...snapshot, gatewayUsageProviderScope: null })).toBe(false);
  expect(isGatewayModelReady(provider, model, { ...snapshot, cloudProviderServerSync: { reloadPending: true, skippedProviders: {} } })).toBe(false);
  expect(isGatewayModelReady(provider, model, { ...snapshot, cloudProviderServerSync: { reloadPending: false, skippedProviders: { [`${provider.cloudProviderId}:${provider.credentialSetId}`]: provider } } })).toBe(false);
});

test.each(["Favorites", "Recent", "Next"])("compact %s selection cannot bypass Login or record a recent model early", async (entry) => {
  const selected: ModelRef[] = [];
  const pending = options[0]!;
  useModelCollectionsStore.setState({ favorites: entry === "Recent" ? [] : [pending], recent: entry === "Recent" ? [pending] : [] });
  const before = useModelCollectionsStore.getState().recent;
  const queryClient = new QueryClient();
  await act(async () => root.render(<PlatformProvider value={createDefaultPlatform()}>
    <QueryClientProvider client={queryClient}>
      <WorkspaceProvider client={null} selectedWorkspaceRoot="/fixture">
        <GatewayModelAccessProvider providers={providers} scopeKey="org/session" login={async () => true}>
          <ModelSelect open value={original} fallbackOptions={[localOption]} onOpenChange={() => undefined} onChange={(model) => selected.push(model)} />
        </GatewayModelAccessProvider>
      </WorkspaceProvider>
    </QueryClientProvider>
  </PlatformProvider>));
  const rootButton = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="model-select-root"] button')).find((node) => node.textContent?.startsWith(entry === "Recent" ? "Model" : "Favorites"));
  if (!rootButton) throw new Error("Missing compact submenu");
  await act(async () => rootButton.click());
  const submenu = entry === "Recent"
    ? Array.from(document.querySelectorAll<HTMLElement>('[data-slot="command-group"]')).find((group) => group.querySelector('[data-slot="command-group-label"]')?.textContent === "Recent")
    : document.querySelector<HTMLElement>('[data-slot="model-favorites-submenu"]');
  if (!submenu) throw new Error(`Missing ${entry} submenu`);
  const choice = entry === "Next"
    ? Array.from(submenu.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.textContent?.startsWith("Next"))
    : submenu.querySelector<HTMLElement>(`[data-model-key="${pending.providerID}:${pending.modelID}"]`);
  if (!choice) throw new Error(`Missing ${entry} model ${pending.modelID}`);
  if (entry !== "Next") {
    expect(choice.textContent).toContain("Personal");
    expect(choice.textContent).toContain("Sign in to use");
  }
  let pickerOpened = 0;
  const onOpen = () => { pickerOpened++; };
  window.addEventListener(openModelPickerEvent, onOpen);
  await act(async () => choice.click());
  window.removeEventListener(openModelPickerEvent, onOpen);
  expect(pickerOpened).toBe(1);
  expect(selected).toEqual([]);
  expect(useModelCollectionsStore.getState().recent).toEqual(before);
  queryClient.clear();
});

test("disabled pending-only provider retains Enable without allowing Login or manufacturing a connection", async () => {
  const selected: ModelRef[] = [];
  const toggles: Array<[string, boolean]> = [];
  let disabledProviders = [providers[0]!.providerId];
  let starts = 0;
  const render = () => root.render(picker({ selected, disabledProviders,
    login: async () => { starts++; return true; },
    onToggleProvider: (id, enabled) => { toggles.push([id, enabled]); disabledProviders = enabled ? [] : [id]; render(); },
  }));
  await act(async () => render());
  expect(document.querySelector(`[title="${options[0]!.modelID}"]`)).toBeNull();
  await click("Enable");
  expect(toggles).toEqual([[providers[0]!.providerId, true]]);
  expect(starts).toBe(0);
  expect(selected).toEqual([]);
  await choose("Personal");
  expect(starts).toBe(1);
  expect(selected).toEqual([{ providerID: options[0]!.providerID, modelID: options[0]!.modelID }]);
});

test("disabled pending and ready favorites/recents stay out of the compact picker", async () => {
  const pending = options[0]!;
  useModelCollectionsStore.setState({ favorites: [pending, localOption], recent: [options[1]!] });
  const queryClient = new QueryClient();
  const selected: ModelRef[] = [];
  let starts = 0;
  await act(async () => root.render(<PlatformProvider value={createDefaultPlatform()}>
    <QueryClientProvider client={queryClient}><WorkspaceProvider client={null} selectedWorkspaceRoot="/fixture">
      <GatewayModelAccessProvider providers={providers} disabledProviders={[pending.providerID, localOption.providerID]} scopeKey="org/session" login={async () => { starts++; return true; }}>
        <ModelSelect open value={original} fallbackOptions={[localOption]} onOpenChange={() => undefined} onChange={(model) => selected.push(model)} />
      </GatewayModelAccessProvider>
    </WorkspaceProvider></QueryClientProvider>
  </PlatformProvider>));
  const favorites = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="model-select-root"] button')).find((node) => node.textContent?.startsWith("Favorites"));
  expect(favorites?.disabled).toBe(true);
  const model = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="model-select-root"] button')).find((node) => node.textContent?.startsWith("Model"));
  if (!model) throw new Error("Missing model submenu");
  await act(async () => model.click());
  expect(document.querySelectorAll("[data-model-key]")).toHaveLength(0);
  expect(starts).toBe(0);
  expect(selected).toEqual([]);
  queryClient.clear();
});

test("the selection gate rejects stale disabled options even if a caller bypasses picker filtering", async () => {
  const selectionRef = createRef<GatewayModelSelectionHandle>();
  const selected: ModelRef[] = [];
  await act(async () => root.render(<GatewayModelAccessProvider providers={providers} disabledProviders={[providers[0]!.providerId]}
    scopeKey="org/session" selectionRef={selectionRef} login={async () => { throw new Error("Must not start Login"); }}>
    <span>Fixture</span>
  </GatewayModelAccessProvider>));
  await act(async () => { selectionRef.current?.select(options[0]!, () => selected.push(options[0]!), () => true); });
  expect(document.body.textContent).not.toContain("Finish signing in in your browser");
  expect(selected).toEqual([]);
});

test.each(["session", "workspace", "pane", "provider-scope"])("secondary favorite completion validates %s identity rather than only the old selection", async (change) => {
  const selectionRef = createRef<GatewayModelSelectionHandle>();
  let workbench: Pick<WorkbenchSnapshot, "focusedPane" | "secondary"> = {
    focusedPane: "secondary", secondary: { workspaceId: "ws_a", sessionId: "session_a" },
  };
  let scope = { workspaceId: "ws_a", sessionId: "primary", providerScopeKey: "account/org/engine-a" };
  const target = captureFavoriteModelTarget(workbench, scope);
  if (!target) throw new Error("Missing initial favorite target");
  const result = deferred();
  let signal: AbortSignal | undefined;
  let globalDefault = original;
  const sessions = { session_a: original, session_b: original };
  await act(async () => root.render(<GatewayModelAccessProvider providers={providers} selectionRef={selectionRef} scopeKey="stable-render"
    login={async (_provider, nextSignal) => { signal = nextSignal; return result.promise; }}>
    <span>Secondary fixture</span>
  </GatewayModelAccessProvider>));
  await act(async () => { selectionRef.current?.select(options[0]!, () => {
    sessions.session_a = options[0]!;
    globalDefault = options[0]!;
  }, () => isFavoriteModelTargetCurrent(target, workbench, scope) && sessions.session_a === original); });
  if (change === "session") workbench = { ...workbench, secondary: { workspaceId: "ws_a", sessionId: "session_b" } };
  if (change === "workspace") workbench = { ...workbench, secondary: { workspaceId: "ws_b", sessionId: "session_a" } };
  if (change === "pane") workbench = { ...workbench, focusedPane: "primary" };
  if (change === "provider-scope") scope = { ...scope, providerScopeKey: "account/org/engine-b" };
  expect(isFavoriteModelTargetCurrent(target, workbench, scope)).toBe(false);
  await act(async () => { result.resolve(true); await result.promise; });
  expect(globalDefault).toBe(original);
  expect(sessions).toEqual({ session_a: original, session_b: original });
  expect(hasPendingGatewayModelSelection()).toBe(false);
});

test("secondary favorite requests never borrow a different workspace's provider scope", () => {
  expect(captureFavoriteModelTarget({ focusedPane: "secondary", secondary: { workspaceId: "ws_b", sessionId: "same-session" } },
    { workspaceId: "ws_a", sessionId: "primary", providerScopeKey: "engine-a" })).toBeNull();
});

test("picker merges pending assignments without exposing the unconnected engine catalog", async () => {
  const { useModelPicker } = await import("../src/react-app/domains/session/modals/use-model-picker");
  const { providerListQueryKey } = await import("../src/react-app/infra/provider-list-query");
  const queryClient = new QueryClient();
  queryClient.setQueryData(providerListQueryKey({ baseUrl: "https://engine.example.test", directory: "/fixture" }), {
    all: [{ id: "unconnected", name: "Hidden catalog", source: "api", models: { unassigned: { name: "Never assigned" } } }],
    connected: [], default: {},
  });
  let signedIn = true;
  let disabledProviders: string[] = [];
  let displayed: ModelOption[] = [];
  function Probe() {
    const picker = useModelPicker({ client: null, baseUrl: "https://engine.example.test", workspaceRoot: "/fixture",
      fallbackOptions: [localOption], pendingProviders: providers, cloudProvidersEnabled: signedIn, disabledProviders });
    displayed = picker.displayOptions;
    return <output>{picker.options.map((option) => option.modelID).join(",")}</output>;
  }
  const render = () => root.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>);
  await act(async () => render());
  expect(host.textContent).toContain(options[0]!.modelID);
  expect(host.textContent).toContain("current");
  expect(host.textContent).not.toContain("unassigned");
  disabledProviders = [options[0]!.providerID, localOption.providerID];
  await act(async () => render());
  expect(host.textContent).toBe("");
  expect(displayed.map((option) => [option.modelID, option.disabled])).toEqual([
    [localOption.modelID, true], ...options.map((option) => [option.modelID, true]),
  ]);
  disabledProviders = [];
  signedIn = false;
  await act(async () => render());
  expect(host.textContent).toBe("current");
  queryClient.clear();
});

test("command palette sends a model that needs sign-in to the picker instead of picking it", async () => {
  const { CommandPalette } = await import("../src/react-app/shell/command-palette");
  const selected: ModelRef[] = [];
  let closed = 0;
  let pickerOpened = 0;
  const onOpen = () => { pickerOpened++; };
  await act(async () => root.render(<PlatformProvider value={createDefaultPlatform()}>
    <GatewayModelAccessProvider providers={providers} scopeKey="org/session" login={async () => true}>
      <CommandPalette open developerMode={false} sessions={[]} selectedModel={original}
        modelOptions={options.map((option) => ({ ...option, behaviorOptions: [{ value: "fast", label: "Fast", description: "" }] }))}
        onSelectModel={(model) => selected.push(model)} onClose={() => { closed++; }} onOpenSession={() => undefined}
        onCreateNewSession={() => undefined} onOpenSettings={() => undefined} onOpenExtensions={() => undefined} />
    </GatewayModelAccessProvider>
  </PlatformProvider>));
  const models = document.querySelector<HTMLElement>('[data-command-palette-item="models"]');
  if (!models) throw new Error("Missing palette models action");
  await act(async () => models.click());
  const model = Array.from(document.querySelectorAll<HTMLElement>("[data-command-palette-item]")).find((item) => item.textContent?.includes("Personal"));
  if (!model) throw new Error("Missing palette pending model");
  window.addEventListener(openModelPickerEvent, onOpen);
  await act(async () => model.click());
  window.removeEventListener(openModelPickerEvent, onOpen);
  expect(pickerOpened).toBe(1);
  expect(closed).toBe(1);
  expect(selected).toEqual([]);
});
