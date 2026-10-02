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
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
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

async function mountCatalogActions(
  extraProviders: Array<{ id: string; name: string; connected: boolean; models: Record<string, { name: string }> }> = [],
  options?: {
    statusesBySessionId?: Record<string, { type: "running" } | undefined>;
    archivedSessionIds?: string[];
    failSetModel?: boolean;
  },
) {
  const requests: Array<{ path: string; method: string; directory: string | null; body?: unknown }> = [];
  const unavailable = new Set<string>();
  const names: Record<string, string> = { one: "GPT-6 Luna", two: "Local Luna" };
  const statusesBySessionId = options?.statusesBySessionId ?? {};
  const archivedSessionIds = new Set(options?.archivedSessionIds ?? []);
  const reboundModels = new Map<string, { providerID: string; id: string; variant?: string | null }>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
      requests.push({ path: url.pathname, method: request.method, directory: url.searchParams.get("directory"), body });
      const providerWorkspaceId = /^\/workspace\/([^/]+)\/opencode\/provider$/.exec(url.pathname)?.[1];
      if (providerWorkspaceId) {
        if (unavailable.has(providerWorkspaceId)) return NativeResponse.json({ message: "Unavailable" }, { status: 503 });
        return NativeResponse.json({ connected: ["provider", ...extraProviders.filter((provider) => provider.connected).map((provider) => provider.id)], default: {}, all: [
          { id: "provider", name: `Provider ${providerWorkspaceId}`, models: { opaque: { name: names[providerWorkspaceId] } } },
          { id: "offline", name: "Offline", models: { hidden: { name: "Hidden" } } },
          ...extraProviders,
        ] });
      }
      const sessionStatus = /^\/workspace\/([^/]+)\/opencode\/(?:api\/)?session\/active$/.exec(url.pathname);
      if (sessionStatus && request.method === "GET") {
        return NativeResponse.json(statusesBySessionId);
      }
      const sessionGet = /^\/workspace\/([^/]+)\/opencode\/(?:api\/)?session\/([^/]+)$/.exec(url.pathname);
      if (sessionGet && request.method === "GET") {
        const [, workspaceId, sessionId] = sessionGet;
        const baseModel = reboundModels.get(sessionId) ?? { providerID: "provider", id: "opaque", variant: sessionId === "ses_one" ? "high" : null };
        return NativeResponse.json({
          id: sessionId,
          model: baseModel,
          time: { archived: archivedSessionIds.has(sessionId) ? 123 : 0 },
          directory: `/tmp/${workspaceId}`,
        });
      }
      const sessionModel = /^\/workspace\/([^/]+)\/opencode\/api\/session\/([^/]+)\/model$/.exec(url.pathname);
      if (sessionModel && request.method === "POST") {
        if (options?.failSetModel) return NativeResponse.json({ message: "Denied" }, { status: 403 });
        const [, , sessionId] = sessionModel;
        if (body && typeof body === "object" && body !== null && "model" in body) {
          const candidate = (body as { model?: { providerID?: string; id?: string; variant?: string | null } }).model;
          if (candidate?.providerID && candidate.id) reboundModels.set(sessionId, candidate);
        }
        return NativeResponse.json({ data: {} });
      }
      return NativeResponse.json({ message: `Unexpected request: ${request.method} ${url.pathname}` }, { status: 404 });
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
      canCreateTask: false, openworkClient: client,
      opencodeClient: createClientV2(`${baseUrl}/workspace/one/opencode`, "/tmp/one", { token: "fixture" }) as never,
      endpointForWorkspace,
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
    { path: "/workspace/one/opencode/provider", method: "GET", directory: "/tmp/one", body: undefined },
    { path: "/workspace/two/opencode/provider", method: "GET", directory: "/tmp/two", body: undefined },
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
  { config: { allowCustomProviders: false, allowZenModel: false }, signedIn: true, expected: ["opencode", "ipr_fixture"] },
  { config: { allowCustomProviders: false, allowZenModel: true }, signedIn: true, expected: ["opencode", "ipr_fixture"] },
  { config: {}, signedIn: false, expected: ["provider", "opencode"] },
  { config: { allowCustomProviders: false, allowZenModel: false }, signedIn: false, expected: ["opencode"] },
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
  expect(requests).toEqual([{ path: "/workspace/two/opencode/provider", method: "GET", directory: "/tmp/two", body: undefined }]);
});

test("unknown or missing workspaces do not silently list selected workspace models", async () => {
  const { api, requests } = await mountCatalogActions();
  expect(await api.query({ id: "models.list", args: { workspaceId: "missing" } })).toMatchObject({ ok: false });
  expect(await api.query({ id: "models.list", args: {} })).toMatchObject({ ok: false });
  expect(requests).toEqual([]);
});

test("session.set_model rebinds an idle session and reads back the exact canonical binding", async () => {
  const { api, requests } = await mountCatalogActions();
  const result = await api.command({
    id: "session.set_model",
    args: { sessionId: "ses_one", providerId: "provider", modelId: "opaque", variant: "high" },
  });
  expect(result).toMatchObject({
    ok: true,
    result: {
      ok: true,
      sessionId: "ses_one",
      workspaceId: "one",
      model: {
        providerId: "provider",
        modelId: "opaque",
        variant: "high",
        displayName: "GPT-6 Luna",
        providerName: "Provider one",
      },
    },
  });
  expect(requests.map((request) => request.path)).toEqual([
    "/workspace/one/opencode/api/session/ses_one",
    "/workspace/one/opencode/api/session/active",
    "/workspace/one/opencode/provider",
    "/workspace/one/opencode/api/session/ses_one/model",
    "/workspace/one/opencode/api/session/ses_one",
  ]);
  expect(requests[3]?.body).toEqual({ model: { providerID: "provider", id: "opaque", variant: "high" } });
});

test("session.set_model rejects archived, busy, missing-workspace and unavailable selections", async () => {
  {
    const { api } = await mountCatalogActions([], { archivedSessionIds: ["ses_one"] });
    expect(await api.command({ id: "session.set_model", args: { sessionId: "ses_one", providerId: "provider", modelId: "opaque" } })).toMatchObject({ ok: false, error: expect.stringContaining("Archived sessions cannot be reassigned") });
  }
  {
    const { api } = await mountCatalogActions([], { statusesBySessionId: { ses_one: { type: "running" } } });
    expect(await api.command({ id: "session.set_model", args: { sessionId: "ses_one", providerId: "provider", modelId: "opaque" } })).toMatchObject({ ok: false, error: expect.stringContaining("Working sessions cannot be reassigned") });
  }
  {
    const { api } = await mountCatalogActions();
    expect(await api.command({ id: "session.set_model", args: { sessionId: "ses_missing", providerId: "provider", modelId: "opaque" } })).toMatchObject({ ok: false, error: expect.stringContaining("pass workspaceId") });
    expect(await api.command({ id: "session.set_model", args: { sessionId: "ses_one", workspaceId: "missing", providerId: "provider", modelId: "opaque" } })).toMatchObject({ ok: false, error: expect.stringContaining("Workspace was not found") });
    expect(await api.command({ id: "session.set_model", args: { sessionId: "ses_one", providerId: "provider", modelId: "missing" } })).toMatchObject({ ok: false, error: expect.stringContaining("Unavailable model") });
  }
});

test("session.set_model surfaces canonical model endpoint denial", async () => {
  const { api } = await mountCatalogActions([], { failSetModel: true });
  expect(await api.command({ id: "session.set_model", args: { sessionId: "ses_one", providerId: "provider", modelId: "opaque" } })).toMatchObject({ ok: false, error: expect.stringContaining("Denied") });
});
