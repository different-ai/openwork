import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { createClient } from "../src/app/lib/opencode";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import type { ProviderListItem, WorkspaceDisplay } from "../src/app/types";
import { createProviderAuthStore, type ProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import { providerListLoadState } from "../src/react-app/domains/models/use-model-catalog";
import {
  clearProviderListQueries,
  ensureProviderCatalogQuery,
  fetchProviderList,
  readSavedProviderList,
  useProviderListQuery,
} from "../src/react-app/infra/provider-list-query";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

const ownedDom = typeof globalThis.window === "undefined";
beforeAll(() => { if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" }); });
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });

const directory = "/workspace/provider-list";
const zen: ProviderListItem = {
  id: "opencode", name: "OpenCode Zen", source: "custom", env: [], options: {},
  models: { "big-pickle": { id: "big-pickle", providerID: "opencode", name: "Big Pickle", api: { id: "big-pickle", url: "", npm: "" },
    capabilities: { temperature: true, reasoning: true, attachment: false, toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 200000, output: 32000 },
    status: "active", options: {}, headers: {}, release_date: "2026-01-01" } },
};
// Not connected: only the full catalog lists it, for the Connect modal.
const anthropic: ProviderListItem = { id: "anthropic", name: "Anthropic", source: "env", env: ["ANTHROPIC_API_KEY"], options: {}, models: {} };

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

type EngineRequest = { method: string; path: string; directory: string | null };

/** A v1 engine: `/config/providers` lists connected providers, `/provider` the whole catalog. */
function fakeV1Engine() {
  const requests: EngineRequest[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    requests.push({ method: request.method, path: url.pathname, directory: url.searchParams.get("directory") });
    if (url.pathname === "/config/providers") return json({ providers: [zen], default: { opencode: "big-pickle" } });
    if (url.pathname === "/provider") {
      return json({ all: [zen, anthropic], connected: ["opencode"], default: { opencode: "big-pickle", anthropic: "claude" } });
    }
    if (url.pathname === "/provider/auth") return json({});
    if (url.pathname === "/config") return json({});
    throw new Error(`Unexpected engine request: ${url.pathname}`);
  });
  return requests;
}

afterEach(() => {
  mock.restore();
  clearProviderListQueries(getReactQueryClient());
});

describe("v1 engine", () => {
  test("the picker list reads connected providers, not the whole catalog", async () => {
    const requests = fakeV1Engine();
    const client = createClient("http://engine.test", directory);
    const list = await fetchProviderList({ client, baseUrl: "http://engine.test", directory });
    expect(requests.map(({ path, directory: dir }) => [path, dir])).toEqual([["/config/providers", directory]]);
    expect(list).toEqual({ all: [zen], connected: ["opencode"], default: { opencode: "big-pickle" } });
  });

  test("the full catalog is a separate, explicitly requested read", async () => {
    const requests = fakeV1Engine();
    const client = createClient("http://engine.test", directory);
    const catalog = await ensureProviderCatalogQuery(getReactQueryClient(), { client, baseUrl: "http://engine.test", directory });
    expect(catalog.all.map((provider) => provider.id)).toEqual(["opencode", "anthropic"]);
    await ensureProviderCatalogQuery(getReactQueryClient(), { client, baseUrl: "http://engine.test", directory });
    expect(requests.filter(({ path }) => path === "/provider")).toHaveLength(1);
  });

  test("the Connect modal loads the catalog when it opens, and only then", async () => {
    const requests = fakeV1Engine();
    const client = createClient("http://engine.test", directory);
    const ui: { providers: ProviderListItem[]; defaults: Record<string, string>; connected: string[]; disabled: string[] } = {
      providers: [], defaults: {}, connected: [], disabled: [],
    };
    const workspace: WorkspaceDisplay = { id: "ws", name: "Workspace", path: directory, preset: "default", workspaceType: "local" };
    const store: ProviderAuthStore = createProviderAuthStore({
      client: () => client,
      providers: () => ui.providers,
      providerDefaults: () => ui.defaults,
      providerConnectedIds: () => ui.connected,
      disabledProviders: () => ui.disabled,
      checkDesktopAppRestriction: () => false,
      selectedWorkspaceDisplay: () => workspace,
      providerBaseUrl: () => "http://engine.test",
      selectedWorkspaceRoot: () => directory,
      runtimeWorkspaceId: () => workspace.id,
      openworkServer: { getSnapshot: () => ({ openworkServerStatus: "disconnected", openworkServerClient: null, openworkServerCapabilities: null }) },
      setProviders: (value) => { ui.providers = value; },
      setProviderDefaults: (value) => { ui.defaults = value; },
      setProviderConnectedIds: (value) => { ui.connected = value; },
      setDisabledProviders: (value) => { ui.disabled = value; },
      markOpencodeConfigReloadRequired: () => undefined,
    });
    try {
      await store.refreshProviders();
      expect(ui.providers.map((provider) => provider.id)).toEqual(["opencode"]);
      expect(requests.some(({ path }) => path === "/provider")).toBe(false);

      await store.openProviderAuthModal();
      expect(requests.filter(({ path }) => path === "/provider")).toHaveLength(1);
      const snapshot = store.getSnapshot();
      expect(snapshot.providerAuthProviders.map((provider) => provider.id)).toContain("anthropic");
      expect(snapshot.providerAuthMethods.anthropic?.some((method) => method.type === "api")).toBe(true);
      // The picker's list is untouched by the catalog.
      expect(ui.providers.map((provider) => provider.id)).toEqual(["opencode"]);
    } finally {
      store.dispose();
    }
  });
});

describe("v2 engine", () => {
  test("the same reader goes through the v2 adapter and never asks for /config/providers", async () => {
    const paths: string[] = [];
    spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.endsWith("/api/model")) return json({ data: [{ id: "big-pickle", providerID: "opencode", name: "Big Pickle" }] });
      if (path.endsWith("/api/model/default")) return json({ data: { providerID: "opencode", id: "big-pickle" } });
      if (path.endsWith("/api/provider")) return json({ data: [{ id: "opencode", name: "OpenCode Zen" }] });
      throw new Error(`Unexpected v2 request: ${path}`);
    });
    const client = createClientV2("http://engine.test/opencode2", directory, {});
    const list = await fetchProviderList({ client, baseUrl: "http://engine.test/opencode2", directory });
    expect(paths.some((path) => path.includes("/config/providers"))).toBe(false);
    expect(paths.toSorted()).toEqual(["/opencode2/api/model", "/opencode2/api/model/default", "/opencode2/api/provider"]);
    expect(list.connected).toEqual(["opencode"]);
    expect(list.all.map((provider) => [provider.id, provider.name, Object.keys(provider.models)])).toEqual([["opencode", "OpenCode Zen", ["big-pickle"]]]);
  });

  test("config.providers and provider.list agree, since v2 only lists usable providers", async () => {
    spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/api/model")) return json({ data: [{ id: "big-pickle", providerID: "opencode", name: "Big Pickle" }] });
      if (path.endsWith("/api/model/default")) return json({ data: {} });
      if (path.endsWith("/api/provider")) return json({ data: [{ id: "opencode", name: "OpenCode Zen" }] });
      throw new Error(`Unexpected v2 request: ${path}`);
    });
    const client = createClientV2("http://engine.test/opencode2", directory, {});
    const [connected, all] = await Promise.all([client.config.providers({ directory }), client.provider.list({ directory })]);
    expect(connected.data?.providers).toEqual(all.data?.all);
    expect(connected.data?.default).toEqual(all.data?.default);
  });

  test("a failed v2 model read fails config.providers instead of returning an empty list", async () => {
    spyOn(globalThis, "fetch").mockImplementation(async () => json({ name: "UnknownError" }, 503));
    const client = createClientV2("http://engine.test/opencode2", directory, {});
    const result = await client.config.providers({ directory });
    expect(result.data).toBeUndefined();
    expect(result.response.status).toBe(503);
    await expect(fetchProviderList({ client, directory })).rejects.toBeDefined();
  });
});

describe("saved list for the next launch", () => {
  test("is saved per folder with connected providers only, and cleared on sign-out", async () => {
    fakeV1Engine();
    const client = createClient("http://engine.test", directory);
    expect(readSavedProviderList(directory)).toBeUndefined();
    await fetchProviderList({ client, baseUrl: "http://engine.test:1111", directory });
    // The engine port changes every launch; the saved list is keyed by folder.
    expect(readSavedProviderList(directory)).toEqual({ all: [zen], connected: ["opencode"], default: { opencode: "big-pickle" } });
    expect(readSavedProviderList("/another/folder")).toBeUndefined();
    clearProviderListQueries(getReactQueryClient());
    expect(readSavedProviderList(directory)).toBeUndefined();
  });

  test("a corrupt or foreign saved value is ignored", () => {
    window.localStorage.setItem(`openwork.providerList.v1:${directory}`, "{not json");
    expect(readSavedProviderList(directory)).toBeUndefined();
    window.localStorage.setItem(`openwork.providerList.v1:${directory}`, JSON.stringify({ savedAt: 1, value: { all: [{ name: "no id" }], connected: [], default: {} } }));
    expect(readSavedProviderList(directory)).toBeUndefined();
  });

  test("a saved list keeps the picker loading, so the current model is never called unavailable from it", () => {
    const base = { isError: false, isPending: false, isPlaceholderData: false, active: true };
    expect(providerListLoadState({ ...base, isPlaceholderData: true })).toBe("loading");
    expect(providerListLoadState({ ...base, isPlaceholderData: true, active: false })).toBe("loading");
    expect(providerListLoadState({ ...base, isPending: true })).toBe("loading");
    expect(providerListLoadState({ ...base, isPending: true, active: false })).toBe("ready");
    expect(providerListLoadState(base)).toBe("ready");
    expect(providerListLoadState({ ...base, isError: true, isPlaceholderData: true })).toBe("error");
  });

  test("a picker shows the saved list before the engine is reachable, marked as placeholder data", async () => {
    const saved: ProviderListResponse = { all: [zen], connected: ["opencode"], default: { opencode: "big-pickle" } };
    window.localStorage.setItem(`openwork.providerList.v1:${directory}`, JSON.stringify({ savedAt: 1, value: saved }));
    const seen: Array<{ ids: string[]; placeholder: boolean }> = [];
    const actEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    function Picker({ saved: showSaved }: { saved: boolean }) {
      // No client yet: the desktop window is still connecting to the engine.
      const query = useProviderListQuery({ client: null, baseUrl: "", directory, showSavedWhileLoading: showSaved });
      seen.push({ ids: query.data?.all.map((provider) => provider.id) ?? [], placeholder: query.isPlaceholderData });
      return null;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<QueryClientProvider client={getReactQueryClient()}><Picker saved /></QueryClientProvider>));
      expect(seen.at(-1)).toEqual({ ids: ["opencode"], placeholder: true });
      // Automatic model decisions use the same query without the saved list.
      await act(async () => root.render(<QueryClientProvider client={getReactQueryClient()}><Picker saved={false} /></QueryClientProvider>));
      expect(seen.at(-1)).toEqual({ ids: [], placeholder: false });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      if (actEnvironment) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
      else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    }
  });
});
