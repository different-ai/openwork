import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

// #6283: when the engine cannot list provider sign-in methods (for example a
// custom provider in opencode.json without npm or baseURL), Connect must show
// that error instead of doing nothing.

beforeEach(() => {
  GlobalRegistrator.register({ url: "http://localhost:5173/" });
});
afterEach(async () => {
  getReactQueryClient().clear();
  await GlobalRegistrator.unregister();
});

const engineError = "Failed to load auth provider metadata from broken-provider: fetch() URL is invalid";

function mockEngine(authFails: boolean) {
  const requests: string[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path.endsWith("/provider/auth")) {
      if (authFails) return Response.json({ name: "UnknownError", data: { message: engineError } }, { status: 500 });
      return Response.json({ anthropic: [{ type: "api", label: "API key" }] });
    }
    return Response.json({});
  });
  return { requests, restore: () => fetch.mockRestore() };
}

function createStore(withClient = true) {
  const server = createOpenworkServerClient({ baseUrl: "http://localhost:8787", hostToken: "fixture-host" });
  const client = createClientV2("http://localhost:8787/opencode2", "/workspace", {});
  return createProviderAuthStore({
    client: () => (withClient ? client : null),
    providers: () => [], providerDefaults: () => ({}), providerConnectedIds: () => [], disabledProviders: () => [],
    checkDesktopAppRestriction: () => false,
    selectedWorkspaceDisplay: () => ({ id: "workspace", name: "Workspace", path: "/workspace", preset: "default", workspaceType: "local" }),
    providerBaseUrl: () => "http://localhost:8787/opencode2", selectedWorkspaceRoot: () => "/workspace",
    runtimeWorkspaceId: () => "workspace",
    openworkServer: { getSnapshot: () => ({
      openworkServerStatus: "connected", openworkServerClient: server,
      openworkServerCapabilities: {}, openworkServerAuth: { hostToken: "fixture-host" },
    }) },
    setProviders: () => {}, setProviderDefaults: () => {}, setProviderConnectedIds: () => {}, setDisabledProviders: () => {},
    markOpencodeConfigReloadRequired: () => {},
  });
}

test("Connect opens the dialog with the engine error when sign-in methods fail to load", async () => {
  const engine = mockEngine(true);
  const store = createStore();
  try {
    await store.openProviderAuthModal({ returnFocusTarget: "composer" });
    const snapshot = store.getSnapshot();
    expect(engine.requests.some((request) => request.endsWith("/provider/auth"))).toBe(true);
    expect(snapshot.providerAuthModalOpen).toBe(true);
    expect(snapshot.providerAuthBusy).toBe(false);
    expect(snapshot.providerAuthMethods).toEqual({});
    expect(snapshot.providerAuthError).toContain("Failed to load providers");
    expect(snapshot.providerAuthError).toContain("fetch() URL is invalid");
  } finally {
    store.dispose();
    engine.restore();
  }
});

test("closing the dialog clears the load error", async () => {
  const engine = mockEngine(true);
  const store = createStore();
  try {
    await store.openProviderAuthModal();
    store.closeProviderAuthModal({ restorePromptFocus: false });
    expect(store.getSnapshot().providerAuthModalOpen).toBe(false);
    expect(store.getSnapshot().providerAuthError).toBeNull();
  } finally {
    store.dispose();
    engine.restore();
  }
});

test("Connect still opens the dialog with sign-in methods when they load", async () => {
  const engine = mockEngine(false);
  const store = createStore();
  try {
    await store.openProviderAuthModal();
    const snapshot = store.getSnapshot();
    expect(snapshot.providerAuthModalOpen).toBe(true);
    expect(snapshot.providerAuthError).toBeNull();
    expect(Object.keys(snapshot.providerAuthMethods)).toContain("anthropic");
  } finally {
    store.dispose();
    engine.restore();
  }
});

test("without a workspace engine Connect still rejects so callers can open AI Providers", async () => {
  const engine = mockEngine(true);
  const store = createStore(false);
  try {
    await expect(store.openProviderAuthModal()).rejects.toThrow();
    expect(store.getSnapshot().providerAuthModalOpen).toBe(false);
    expect(store.getSnapshot().providerAuthError).toBeTruthy();
  } finally {
    store.dispose();
    engine.restore();
  }
});
