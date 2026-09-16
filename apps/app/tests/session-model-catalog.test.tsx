import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { z } from "zod";
import { openworkSessionModelSchema } from "@openwork/types/openwork-affordance";
import type { ResolvedWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import type { OpenworkControlAPI } from "../src/react-app/shell/control/control-provider";
import type { RouteWorkspace } from "../src/react-app/shell/route-workspaces";
import { checkDesktopAppRestriction, type DesktopAppRestrictionChecker } from "../src/app/cloud/desktop-app-restrictions";
import type { DenDesktopConfig } from "../src/app/lib/den";

let policy: DenDesktopConfig = {};
let signedIn = true;
const checkRestriction: DesktopAppRestrictionChecker = (input) => checkDesktopAppRestriction({ ...input, config: policy });
mock.module("../src/react-app/domains/cloud/desktop-config-provider", () => ({ useCheckDesktopRestriction: () => checkRestriction }));
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({ useDenAuth: () => ({ isSignedIn: signedIn }) }));

const nativeHttp = { fetch: globalThis.fetch, Request, Response, Headers, AbortController, AbortSignal };
const NativeResponse = globalThis.Response;
const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
for (const [key, value] of Object.entries(nativeHttp)) {
  Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperty(window, key, { configurable: true, value });
}
const [
  { OpenworkControlProvider },
  { useSessionControlActions },
  { createOpenworkServerClient },
] = await Promise.all([
  import("../src/react-app/shell/control/control-provider"),
  import("../src/react-app/domains/session/control/session-control-actions"),
  import("../src/app/lib/openwork-server"),
]);
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  policy = {};
  signedIn = true;
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function mountCatalogActions(extraProviders: Array<{ id: string; name: string; connected: boolean; models: Record<string, { name: string }> }> = []) {
  const requests: Array<{ path: string; method: string; directory: string | null }> = [];
  const unavailable = new Set<string>();
  const names: Record<string, string> = { one: "GPT-6 Luna", two: "Local Luna" };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ path: url.pathname, method: request.method, directory: url.searchParams.get("directory") });
      const id = /^\/workspace\/([^/]+)\/opencode\/provider$/.exec(url.pathname)?.[1];
      if (!id || unavailable.has(id)) return NativeResponse.json({ message: "Unavailable" }, { status: 503 });
      return NativeResponse.json({ connected: ["provider", ...extraProviders.filter((provider) => provider.connected).map((provider) => provider.id)], default: {}, all: [
        { id: "provider", name: `Provider ${id}`, models: { opaque: { name: names[id] } } },
        { id: "offline", name: "Offline", models: { hidden: { name: "Hidden" } } },
        ...extraProviders,
      ] });
    },
  });
  cleanups.push(() => server.stop(true));
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const workspaces: RouteWorkspace[] = ["one", "two"].map((id) => ({
    id, name: id, displayNameResolved: id, path: `/tmp/${id}`, preset: "starter", workspaceType: "local",
  }));
  const client = createOpenworkServerClient({ baseUrl, token: "fixture" });
  const endpointForWorkspace = (workspace: RouteWorkspace | null | undefined): ResolvedWorkspaceEndpoint | null => workspace ? {
    baseUrl, token: "fixture", workspaceId: workspace.id, isRemote: false, client,
    mountedBaseUrl: `${baseUrl}/workspace/${workspace.id}`, opencodeBaseUrl: `${baseUrl}/workspace/${workspace.id}/opencode`,
  } : null;
  function Register() {
    useSessionControlActions({
      workspaces, selectedWorkspaceId: "one", selectedWorkspaceRoot: "/tmp/one", selectedSessionId: null,
      sessionsByWorkspaceId: {
        one: [{ id: "ses_one", model: { id: "opaque", providerID: "provider", variant: "high" } }, { id: "unbound" }],
        two: [{ id: "ses_two", model: { id: "opaque", providerID: "provider", variant: "default" } }],
      },
      canCreateTask: false, openworkClient: client, opencodeClient: null, endpointForWorkspace,
      navigateToSession: () => { throw new Error("Must not navigate"); }, navigateToSessionRoot: () => { throw new Error("Must not navigate"); }, createTaskInWorkspace: () => null,
      openModelPicker: () => { throw new Error("Must not open picker"); }, refreshRouteState: () => {}, archiveSession: async () => ({ kind: "done" }),
    });
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<MemoryRouter><OpenworkControlProvider><Register /></OpenworkControlProvider></MemoryRouter>));
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  const api = window.__openworkControl;
  if (!api) throw new Error("Control API unavailable");
  return { api, requests, unavailable, names };
}

async function listedModels(api: OpenworkControlAPI, workspaceId?: string) {
  const result = await api.query({ id: "session.list_sessions", args: workspaceId ? { workspaceId } : {} });
  if (!result.ok) throw new Error(result.error);
  return z.array(z.object({ sessionId: z.string(), model: openworkSessionModelSchema.nullable() })).parse(result.result);
}

test("renderer lists workspace-specific picker labels without changing bound ids or effort", async () => {
  const { api, requests } = await mountCatalogActions();
  expect(await listedModels(api)).toEqual([
    { sessionId: "ses_one", model: { providerId: "provider", modelId: "opaque", variant: "high", displayName: "GPT-6 Luna", providerName: "Provider one" } },
    { sessionId: "unbound", model: null },
    { sessionId: "ses_two", model: { providerId: "provider", modelId: "opaque", variant: null, displayName: "Local Luna", providerName: "Provider two" } },
  ]);
  expect(requests).toEqual([
    { path: "/workspace/one/opencode/provider", method: "GET", directory: "/tmp/one" },
    { path: "/workspace/two/opencode/provider", method: "GET", directory: "/tmp/two" },
  ]);
});

test("renderer models.list reads a nonselected workspace and excludes disconnected providers", async () => {
  const { api, requests } = await mountCatalogActions();
  expect(await api.query({ id: "models.list", args: { workspaceId: "two" } })).toMatchObject({
    ok: true, effects: { data: "read", ui: "none", external: false },
    result: { ok: true, workspaceId: "two", models: [{ providerId: "provider", modelId: "opaque", displayName: "Local Luna", providerName: "Provider two", available: true }] },
  });
  expect(requests.map((request) => request.path)).toEqual(["/workspace/two/opencode/provider"]);
});

test("renderer refreshes names and scopes catalog reads to the requested workspace", async () => {
  const { api, requests, names } = await mountCatalogActions();
  await listedModels(api, "two");
  names.two = "Updated Luna";
  expect((await listedModels(api, "two"))[0]?.model?.displayName).toBe("Updated Luna");
  expect(requests.every((request) => request.path === "/workspace/two/opencode/provider")).toBe(true);
});

test("catalog outages preserve session inventory with ids-only metadata but fail models.list", async () => {
  const { api, unavailable } = await mountCatalogActions();
  unavailable.add("two");
  expect(await listedModels(api, "two")).toEqual([{ sessionId: "ses_two", model: { providerId: "provider", modelId: "opaque", variant: null } }]);
  expect(await api.query({ id: "models.list", args: { workspaceId: "two" } })).toMatchObject({ ok: false });
});

test.each([
  { config: { allowCustomProviders: false, allowZenModel: false }, signedIn: true, expected: ["ipr_fixture"] },
  { config: { allowCustomProviders: false, allowZenModel: true }, signedIn: true, expected: ["opencode", "ipr_fixture"] },
  { config: {}, signedIn: false, expected: ["provider", "opencode"] },
  { config: { allowCustomProviders: false, allowZenModel: false }, signedIn: false, expected: [] },
])("renderer applies live picker policy and sign-in state: %j", async (scenario) => {
  policy = scenario.config;
  signedIn = scenario.signedIn;
  const { api, requests } = await mountCatalogActions([
    { id: "opencode", name: "Zen", connected: true, models: { zen: { name: "Zen model" } } },
    { id: "ipr_fixture", name: "Managed", connected: true, models: { cloud: { name: "Cloud model" } } },
    { id: "ipr_pending", name: "Assigned pending", connected: false, models: { pending: { name: "Not engine-connected" } } },
  ]);
  const result = await api.query({ id: "models.list", args: { workspaceId: "two" } });
  if (!result.ok) throw new Error(result.error);
  const catalog = z.object({ workspaceId: z.literal("two"), models: z.array(z.object({ providerId: z.string(), available: z.literal(true) })) }).parse(result.result);
  expect(catalog.models.map((model) => model.providerId)).toEqual(scenario.expected);
  expect(requests).toEqual([{ path: "/workspace/two/opencode/provider", method: "GET", directory: "/tmp/two" }]);
});

test("unknown or missing workspaces do not silently list selected workspace models", async () => {
  const { api, requests } = await mountCatalogActions();
  expect(await api.query({ id: "models.list", args: { workspaceId: "missing" } })).toMatchObject({ ok: false });
  expect(await api.query({ id: "models.list", args: {} })).toMatchObject({ ok: false });
  expect(requests).toEqual([]);
});
