import { expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as navigation from "next/navigation";
import * as requests from "../app/(den)/_lib/den-flow";
import * as runtime from "../app/(den)/_lib/runtime-config";
import * as scope from "../app/(den)/_lib/org-scope";
import * as flow from "../app/(den)/_providers/den-flow-provider";
import * as reauth from "../app/(den)/_components/reauth-dialog";
import { OrgDashboardProvider, useOrgDashboard } from "../app/(den)/dashboard/_providers/org-dashboard-provider";
import GatewayProvidersLayout from "../app/(den)/dashboard/(admin)/gateway-providers/layout";
import AdminDashboardLayout from "../app/(den)/dashboard/(admin)/layout";
import GatewayProvidersPage from "../app/(den)/dashboard/(admin)/gateway-providers/page";
import NewGatewayProviderPage from "../app/(den)/dashboard/(admin)/gateway-providers/new/page";
import GatewayProviderPage from "../app/(den)/dashboard/(admin)/gateway-providers/[inferenceProviderId]/page";
import EditGatewayProviderPage from "../app/(den)/dashboard/(admin)/gateway-providers/[inferenceProviderId]/edit/page";
import { useOrgInferenceProviders } from "../app/(den)/dashboard/_components/inference-provider-data";
import { LlmProviderDetailScreen } from "../app/(den)/dashboard/_components/llm-provider-detail-screen";
import InferencePage from "../app/(den)/dashboard/(admin)/inference/page";
import { parseOrgContextPayload } from "../app/(den)/_lib/den-org";
import { getGatewayDashboardAccess } from "../app/(den)/dashboard/_lib/gateway-dashboard-access";

type Reply = { payload: unknown; status?: number };
const account = { id: "user-1", name: "Member", email: "member@example.test" };
const enabledMetadata = JSON.stringify({ capabilities: { gatewayDashboard: true } });
const orgs = ["a", "b", "c"].map((key) => ({
  id: `org-${key}`, name: `Workspace ${key}`, slug: key, role: "owner",
  orgMemberId: `member-${key}`, membershipId: `membership-${key}`,
}));

function context(id: string, metadata = enabledMetadata, role = "owner", deployment: { deploymentCapabilities?: unknown } = { deploymentCapabilities: { version: 1, aiGateway: true } }): Reply {
  const organization = orgs.find((org) => org.id === id);
  if (!organization) throw new Error(`Unknown fixture organization: ${id}`);
  const parsed: unknown = JSON.parse(metadata);
  const capabilities = parsed && typeof parsed === "object" && "capabilities" in parsed ? parsed.capabilities : undefined;
  return { payload: { organization: { ...organization, metadata }, capabilities, ...deployment, currentMember: {
    id: organization.orgMemberId, userId: account.id, role, isOwner: role === "owner",
  } } };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred result not initialized"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withDashboard(check: (fixture: {
  state: () => ReturnType<typeof useOrgDashboard>;
  container: HTMLDivElement;
  hold: (path: string, orgId?: string) => ReturnType<typeof deferred<Reply>>;
  holdWorkers: () => ReturnType<typeof deferred<void>>;
  calls: { path: string; orgId: string | null }[];
  scopeWrites: { id: string | null; busy: boolean | undefined; contextId: string | undefined; gatewayMounted: boolean }[];
  unmountedScopes: (string | null)[];
  replace: ReturnType<typeof mock<(path: string) => void>>;
  rerender: (user: typeof account | null) => void;
  unmount: () => void;
  verifyReauth: () => Promise<void>;
  tick: () => void;
  workerRefreshCount: () => number;
}) => Promise<void>, options: {
  setupOrganizationId?: string; activeOrgId?: string; singleOrg?: boolean; metadata?: string; role?: string;
  page?: ReactNode; pathname?: string; outsideGateway?: boolean; deploymentCapabilities?: unknown;
  runtimeConfigLoaded?: boolean; initialContext?: ReturnType<typeof deferred<Reply>>; gatewayFailure?: boolean;
} = {}) {
  GlobalRegistrator.register({ url: "https://app.example.test/dashboard/org-settings" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const intervals = new Map<number, () => void>();
  const setInterval = window.setInterval.bind(window);
  const clearInterval = window.clearInterval.bind(window);
  spyOn(window, "setInterval").mockImplementation((handler, timeout, ...args) => {
    const id = setInterval(handler, timeout, ...args);
    if (timeout === 5000 && typeof handler === "function") intervals.set(id, () => handler(...args));
    return id;
  });
  spyOn(window, "clearInterval").mockImplementation((id) => {
    if (typeof id === "number") intervals.delete(id);
    clearInterval(id);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  let mounted = true;
  let current: ReturnType<typeof useOrgDashboard> | null = null;
  let sessionUser: typeof account | null = account;
  let activeOrgId = options.activeOrgId ?? "org-a";
  const pending = new Map<string, ReturnType<typeof deferred<Reply>>[]>();
  let workers: ReturnType<typeof deferred<void>> | null = null;
  const calls: { path: string; orgId: string | null }[] = [];
  const scopeWrites: { id: string | null; busy: boolean | undefined; contextId: string | undefined; gatewayMounted: boolean }[] = [];
  const unmountedScopes: (string | null)[] = [];
  const replace = mock((_path: string) => {});
  let verifyReauth: () => Promise<void> = async () => { throw new Error("Reauth dialog not mounted"); };
  const RealReauthDialog = reauth.ReauthDialog;
  spyOn(reauth, "ReauthDialog").mockImplementation((props) => {
    verifyReauth = props.onVerified;
    return <RealReauthDialog {...props} />;
  });
  const config = { ...runtime.EMPTY_RUNTIME_CONFIG, orgMode: options.singleOrg ? "single_org" : "multi_org" } satisfies runtime.DenWebRuntimeConfig;
  const useRealDenFlow = flow.useDenFlow;
  const setScope = scope.setRequestOrgScope;
  let workerRefreshCount = 0;
  const refreshWorkers = async () => { workerRefreshCount += 1; await workers?.promise; };
  spyOn(scope, "setRequestOrgScope").mockImplementation((id) => {
    scopeWrites.push({ id, busy: current?.orgBusy, contextId: current?.orgContext?.organization.id,
      gatewayMounted: Boolean(container.querySelector("[data-gateway]")) });
    setScope(id);
  });
  spyOn(navigation, "usePathname").mockReturnValue(options.pathname ?? "/dashboard/org-settings");
  spyOn(navigation, "useRouter").mockReturnValue({ push() {}, replace, refresh() {}, back() {}, forward() {}, prefetch: async () => {} });
  spyOn(runtime, "getRuntimeConfig").mockResolvedValue(config);
  // Keep the real parent context shape, overriding only this provider's inputs.
  spyOn(flow, "useDenFlow").mockImplementation(() => ({
    ...useRealDenFlow(), user: sessionUser, sessionHydrated: true, signOut: async () => {},
    refreshWorkers, workersLoadedOnce: true, runtimeConfig: config, runtimeConfigLoaded: options.runtimeConfigLoaded ?? true,
    setupOrganizationId: options.setupOrganizationId ?? null,
  }));
  spyOn(requests, "requestJson").mockImplementation(async (path, init) => {
    const orgId = new Headers(init?.headers).get(scope.ORG_SCOPE_HEADER);
    calls.push({ path, orgId });
    const held = pending.get(`${path}:${orgId ?? ""}`)?.shift();
    const reply: Reply = held ? await held.promise : path === "/v1/me/orgs"
      ? { payload: { orgs: orgs.map((org) => ({ ...org, isActive: org.id === activeOrgId })) } }
      : path === "/v1/org" || path === "/v1/org?refreshRoles=true" ? options.initialContext ? await options.initialContext.promise
        : context(orgId ?? "missing", options.metadata, options.role, "deploymentCapabilities" in options ? { deploymentCapabilities: options.deploymentCapabilities } : undefined)
      : options.gatewayFailure && path.startsWith("/v1/inference-providers") ? { status: 503, payload: { message: "Upstream gateway is offline" } }
      : path === "/v1/inference" ? { payload: { inference: { enabled: true, tier: "tier1", subscribed: true } } }
      : path.startsWith("/v1/llm-providers?") ? { payload: { llmProviders: [{
        id: "llm-1", name: "Test BYOK", organizationId: activeOrgId, createdByOrgMembershipId: "member-a",
        source: "models_dev", providerId: "openai", canManage: true, hasApiKey: true,
        providerConfig: {}, models: [], access: {}, accessibleVia: {},
      }] } }
      : { payload: path === "/v1/me" ? { user: account } : {} };
    if (path === "/api/auth/organization/set-active" && (reply.status ?? 200) === 200) {
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      if (body && typeof body === "object" && "organizationId" in body && typeof body.organizationId === "string") {
        activeOrgId = body.organizationId;
      }
    }
    return { response: Response.json(reply.payload, { status: reply.status ?? 200 }), payload: reply.payload, text: JSON.stringify(reply.payload) };
  });
  function ScopedConsumer() {
    useOrgInferenceProviders(useOrgDashboard().orgId);
    useLayoutEffect(() => () => { unmountedScopes.push(scope.getRequestOrgScope()); }, []);
    return <div data-gateway />;
  }
  function Capture() {
    const state = useOrgDashboard();
    current = state;
    return options.outsideGateway ? options.page : <GatewayProvidersLayout>{options.page ?? <ScopedConsumer />}</GatewayProvidersLayout>;
  }
  const render = () => root.render(<QueryClientProvider client={queryClient}><flow.DenFlowProvider><OrgDashboardProvider><Capture /></OrgDashboardProvider></flow.DenFlowProvider></QueryClientProvider>);
  try {
    await act(async () => render());
    await check({
      state: () => { if (!current) throw new Error("Dashboard not mounted"); return current; },
      container, calls, scopeWrites, unmountedScopes, replace,
      hold: (path, orgId) => {
        const result = deferred<Reply>();
        const key = `${path}:${orgId ?? ""}`;
        pending.set(key, [...(pending.get(key) ?? []), result]);
        return result;
      },
      holdWorkers: () => { workers = deferred<void>(); return workers; },
      rerender: (user) => { sessionUser = user; render(); },
      unmount: () => { root.unmount(); mounted = false; },
      verifyReauth: () => verifyReauth(),
      tick: () => { for (const tick of intervals.values()) tick(); },
      workerRefreshCount: () => workerRefreshCount,
    });
  } finally {
    if (mounted) await act(async () => root.unmount());
    queryClient.clear();
    mock.restore();
    await GlobalRegistrator.unregister();
  }
}

test("switch commits default-deny state and unmounts Gateway before changing request scope", async () => {
  await withDashboard(async ({ state, container, hold, scopeWrites, unmountedScopes, calls }) => {
    expect(container.querySelector("[data-gateway]")).not.toBeNull();
    const next = hold("/v1/org", "org-b");
    await act(async () => state().switchOrganization("b"));
    expect(state()).toMatchObject({ orgId: "org-b", orgContext: null, orgBusy: true, mutationBusy: "switch-organization" });
    expect(scopeWrites.at(-1)).toEqual({ id: "org-b", busy: true, contextId: undefined, gatewayMounted: false });
    expect(unmountedScopes).toEqual(["org-a"]);
    await act(async () => next.resolve(context("org-b", JSON.stringify({ capabilities: { gatewayDashboard: false } }))));
    expect(state()).toMatchObject({ orgId: "org-b", orgBusy: false, orgError: null, mutationBusy: null });
    expect(state().orgContext?.organization.id).toBe("org-b");
    expect(container.querySelector("[data-gateway]")).toBeNull();
    expect(calls.filter((call) => call.path.startsWith("/v1/inference-providers"))).toEqual([
      { path: "/v1/inference-providers?scope=manageable", orgId: "org-a" },
    ]);
  });
});

test.each(["/dashboard/members", "/dashboard/manage-members"])("%s quietly refreshes only visible members context on poll, focus and visibility", async (pathname) => {
  await withDashboard(async ({ state, calls, hold, tick, workerRefreshCount }) => {
    const workersBefore = workerRefreshCount();
    calls.length = 0;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const next = hold("/v1/org", "org-a");
    await act(async () => tick());
    expect(state().orgBusy).toBe(false);
    expect(state().orgContext?.organization.metadata).toBe(enabledMetadata);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(calls).toEqual([{ path: "/v1/org", orgId: "org-a" }]);
    await act(async () => next.resolve(context("org-a", "{}")));
    expect(state().orgContext?.organization.metadata).toBe("{}");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => { tick(); window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
    expect(calls).toHaveLength(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(calls).toEqual(Array.from({ length: 3 }, () => ({ path: "/v1/org", orgId: "org-a" })));
    expect(workerRefreshCount()).toBe(workersBefore);
    expect(state()).toMatchObject({ orgBusy: false, orgError: null });
  }, { pathname, outsideGateway: true });
});

test("non-members pages do not poll or refresh on focus", async () => {
  await withDashboard(async ({ calls, tick }) => {
    calls.length = 0;
    await act(async () => { tick(); window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
    expect(calls).toEqual([]);
  }, { outsideGateway: true });
});

test.each(["switch", "refresh", "sign-out", "user-change", "unmount"])("quiet members refresh cannot overwrite %s", async (operation) => {
  await withDashboard(async ({ state, calls, hold, tick, rerender, unmount }) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const old = hold("/v1/org", "org-a");
    await act(async () => tick());
    await act(async () => {
      if (operation === "switch") state().switchOrganization("b");
      else if (operation === "refresh") await state().refreshOrgData();
      else if (operation === "sign-out") rerender(null);
      else if (operation === "user-change") rerender({ ...account, id: "user-2" });
      else unmount();
    });
    const current = state().orgContext;
    calls.length = 0;
    await act(async () => old.resolve(context("org-a", "{}")));
    expect(state().orgContext).toBe(current);
    expect(calls).toEqual([]);
    if (operation === "sign-out" || operation === "unmount") {
      await act(async () => { tick(); window.dispatchEvent(new Event("focus")); });
      expect(calls).toEqual([]);
    }
  }, { pathname: "/dashboard/members", outsideGateway: true });
});

test("failed quiet refresh leaves the members page intact", async () => {
  await withDashboard(async ({ state, hold, tick }) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const current = state().orgContext;
    const next = hold("/v1/org", "org-a");
    await act(async () => tick());
    await act(async () => next.resolve({ status: 503, payload: { message: "Unavailable" } }));
    expect(state().orgContext).toBe(current);
    expect(state()).toMatchObject({ orgBusy: false, orgError: null });
  }, { pathname: "/dashboard/members", outsideGateway: true });
});

test.each([
  "/dashboard/gateway-providers",
  "/dashboard/gateway-providers/new",
  "/dashboard/gateway-providers/infp_1",
  "/dashboard/gateway-providers/infp_1/edit",
])("disabled direct route %s redirects without mounting its real screen or fetching providers", async (pathname) => {
  const params = Promise.resolve({ inferenceProviderId: "infp_1" });
  const page = pathname.endsWith("/edit") ? await EditGatewayProviderPage({ params })
    : pathname.endsWith("/infp_1") ? await GatewayProviderPage({ params })
    : pathname.endsWith("/new") ? <NewGatewayProviderPage /> : <GatewayProvidersPage />;
  await withDashboard(async ({ container, calls, replace }) => {
    expect(container.querySelector("[data-access-state=denied]")).not.toBeNull();
    expect(replace).toHaveBeenCalledWith("/dashboard");
    expect(calls.some((call) => call.path.startsWith("/v1/inference-providers"))).toBe(false);
    expect(featureCalls(calls)).toEqual([]);
    expect(container.querySelector("[data-testid=gateway-provider-create]")).toBeNull();
  }, { metadata: "{}", pathname, page });
});

test.each(["admin", "super-admin", "owner", "member"])("enabled organization retains %s permissions", async (role) => {
  await withDashboard(async ({ container, calls, replace }) => {
    const enabled = role !== "member";
    expect(Boolean(container.querySelector("[data-gateway]"))).toBe(enabled);
    expect(calls.some((call) => call.path.startsWith("/v1/inference-providers"))).toBe(enabled);
    if (!enabled) expect(replace).toHaveBeenCalledWith("/dashboard");
  }, { role });
});

test("disabled-to-enabled switch waits for the selected org and fetches only that org", async () => {
  await withDashboard(async ({ state, hold, container, calls }) => {
    expect(container.querySelector("[data-gateway]")).toBeNull();
    const next = hold("/v1/org", "org-b");
    await act(async () => state().switchOrganization("b"));
    expect(container.querySelector("[data-gateway]")).toBeNull();
    expect(calls.some((call) => call.path.startsWith("/v1/inference-providers"))).toBe(false);
    await act(async () => next.resolve(context("org-b")));
    expect(container.querySelector("[data-gateway]")).not.toBeNull();
    expect(calls.filter((call) => call.path.startsWith("/v1/inference-providers"))).toEqual([
      { path: "/v1/inference-providers?scope=manageable", orgId: "org-b" },
    ]);
  }, { metadata: "{}" });
});

test.each([false, true])("BYOK remains available with Gateway %s and only opt-in exposes migration", async (enabled) => {
  await withDashboard(async ({ container, calls, state, hold }) => {
    expect(container.textContent).toContain("Test BYOK");
    expect(container.textContent).toContain("Edit Provider");
    expect(Boolean(container.querySelector("[data-testid=llm-provider-move-to-gateway]"))).toBe(enabled);
    expect(calls.some((call) => call.path.startsWith("/v1/inference-providers"))).toBe(false);
    if (enabled) {
      const button = container.querySelector<HTMLButtonElement>("[data-testid=llm-provider-move-to-gateway]");
      await act(async () => button?.click());
      expect(container.querySelector("[data-testid=llm-provider-move-to-gateway-confirm]")).not.toBeNull();
      const next = hold("/v1/org", "org-b");
      await act(async () => state().switchOrganization("b"));
      expect(container.querySelector("[data-testid=llm-provider-move-to-gateway-confirm]")).toBeNull();
      await act(async () => next.resolve(context("org-b", "{}")));
      expect(container.querySelector("[data-testid=llm-provider-move-to-gateway]")).toBeNull();
    }
  }, { metadata: enabled ? enabledMetadata : "{}", outsideGateway: true,
    page: <LlmProviderDetailScreen llmProviderId="llm-1" /> });
});

test.each(["{}", '{"capabilities":null}', '{"capabilities":{"gatewayDashboard":false}}', '{"capabilities":{"gatewayDashboard":"true"}}', '{"capabilities":{"gatewayDashboard":1}}'])("missing or malformed Gateway config fails closed: %s", async (metadata) => {
  await withDashboard(async ({ container, state, calls }) => {
    expect(state().orgContext?.capabilities.gatewayDashboard).toBe(false);
    expect(container.querySelector("[data-gateway]")).toBeNull();
    expect(calls.some((call) => call.path.startsWith("/v1/inference-providers"))).toBe(false);
  }, { metadata });
});

test.each(["directory", "context"])("older refresh %s responses cannot replace a switch or clear its busy state", async (phase) => {
  await withDashboard(async ({ state, hold }) => {
    const old = phase === "directory" ? hold("/v1/me/orgs") : hold("/v1/org", "org-a");
    let refresh: Promise<void> | undefined;
    await act(async () => { refresh = state().refreshOrgData(); });
    const next = hold("/v1/org", "org-b");
    await act(async () => state().switchOrganization("b"));
    await act(async () => {
      old.resolve(phase === "directory" ? { payload: { orgs: orgs.map((org) => ({ ...org, isActive: org.id === "org-a" })) } } : context("org-a"));
      await refresh;
    });
    expect(state()).toMatchObject({ orgId: "org-b", orgContext: null, orgBusy: true, mutationBusy: "switch-organization", orgError: null });
    expect(scope.getRequestOrgScope()).toBe("org-b");
    await act(async () => next.resolve(context("org-b")));
    expect(state().orgContext?.organization.id).toBe("org-b");
  });
});

test.each([200, 404, 503])("late switch response (%s) cannot overwrite a completed newer switch", async (status) => {
  await withDashboard(async ({ state, hold, replace }) => {
    const old = hold("/v1/org", "org-b");
    await act(async () => state().switchOrganization("b"));
    await act(async () => state().switchOrganization("c"));
    replace.mockClear();
    await act(async () => old.resolve({ ...context("org-b"), status }));
    expect(state()).toMatchObject({ orgId: "org-c", orgBusy: false, orgError: null, orgSelectionOpen: false, mutationBusy: null });
    expect(state().orgContext?.organization.id).toBe("org-c");
    expect(scope.getRequestOrgScope()).toBe("org-c");
    expect(replace).not.toHaveBeenCalled();
  });
});

test("late set-active responses stop before loading context; a refresh during switching cannot restore the old org", async () => {
  await withDashboard(async ({ state, hold, calls }) => {
    const old = hold("/api/auth/organization/set-active");
    await act(async () => state().switchOrganization("b"));
    const next = hold("/v1/org", "org-c");
    await act(async () => state().switchOrganization("c"));
    const count = calls.length;
    await act(async () => state().refreshOrgData());
    expect(calls.length).toBe(count);
    await act(async () => old.resolve({ payload: {} }));
    expect(calls.filter((call) => call.path === "/v1/org" && call.orgId === "org-b")).toEqual([]);
    expect(state()).toMatchObject({ orgBusy: true, mutationBusy: "switch-organization", orgContext: null });
    expect(scope.getRequestOrgScope()).toBe("org-c");
    await act(async () => next.resolve(context("org-c")));
    // Even if the stale POST changed the server session, the tab restores its latest selection.
    await act(async () => state().refreshOrgData());
    expect(state().orgContext?.organization.id).toBe("org-c");
    expect(scope.getRequestOrgScope()).toBe("org-c");
  });
});

test("overlapping refreshes keep the latest busy state and capability result", async () => {
  await withDashboard(async ({ state, hold, container }) => {
    const old = hold("/v1/org", "org-a");
    let first: Promise<void> | undefined;
    await act(async () => { first = state().refreshOrgData(); });
    const next = hold("/v1/org", "org-a");
    let second: Promise<void> | undefined;
    await act(async () => { second = state().refreshOrgData(); });
    await act(async () => { old.resolve(context("org-a")); await first; });
    expect(state().orgBusy).toBe(true);
    expect(container.querySelector("[data-gateway]")).toBeNull();
    await act(async () => { next.resolve(context("org-a", "{}")); await second; });
    expect(state().orgBusy).toBe(false);
    expect(state().orgContext?.organization.metadata).toBe("{}");
    expect(container.querySelector("[data-gateway]")).toBeNull();
  });
});

test("a retained refresh callback uses the latest selected organization, not its render's old context", async () => {
  await withDashboard(async ({ state }) => {
    const refresh = state().refreshOrgData;
    await act(async () => state().switchOrganization("b"));
    await act(async () => refresh());
    expect(state().orgContext?.organization.id).toBe("org-b");
    expect(scope.getRequestOrgScope()).toBe("org-b");
  });
});

test("refresh-driven scope changes also commit default-deny before changing the header", async () => {
  await withDashboard(async ({ state, hold, scopeWrites, container }) => {
    const directory = hold("/v1/me/orgs");
    const next = hold("/v1/org", "org-b");
    await act(async () => { void state().refreshOrgData(); });
    await act(async () => directory.resolve({ payload: { orgs: orgs.filter((org) => org.id === "org-b").map((org) => ({ ...org, isActive: true })) } }));
    expect(scopeWrites.at(-1)).toEqual({ id: "org-b", busy: true, contextId: undefined, gatewayMounted: false });
    expect(state().orgId).toBe("org-b");
    expect(container.querySelector("[data-gateway]")).toBeNull();
    await act(async () => next.resolve(context("org-b")));
    expect(state().orgContext?.organization.id).toBe("org-b");
  });
});

test.each(["refresh", "switch"])("%s rejects a mismatched org response and fails closed", async (operation) => {
  await withDashboard(async ({ state, hold, container }) => {
    const next = hold("/v1/org", operation === "refresh" ? "org-a" : "org-b");
    await act(async () => { if (operation === "refresh") void state().refreshOrgData(); else state().switchOrganization("b"); });
    await act(async () => next.resolve(context("org-c")));
    expect(state().orgContext).toBeNull();
    expect(state().orgError).toBe("Organization context did not match the requested workspace.");
    expect(state().orgBusy).toBe(false);
    expect(scope.getRequestOrgScope()).toBeNull();
    expect(container.querySelector("[data-gateway]")).toBeNull();
  });
});

test.each(["refresh", "switch"])("%s errors clear verified context and scope, and allow an explicit retry", async (operation) => {
  await withDashboard(async ({ state, hold, container }) => {
    const next = hold("/v1/org", operation === "refresh" ? "org-a" : "org-b");
    await act(async () => { if (operation === "refresh") void state().refreshOrgData(); else state().switchOrganization("b"); });
    await act(async () => next.resolve({ status: 503, payload: { message: "Unavailable" } }));
    expect(state()).toMatchObject({ orgBusy: false, orgContext: null, mutationBusy: null });
    expect(state().orgError).toBeTruthy();
    expect(scope.getRequestOrgScope()).toBeNull();
    expect(container.querySelector("[data-gateway]")).toBeNull();
    await act(async () => state().refreshOrgData());
    expect(state().orgError).toBeNull();
    expect(state().orgContext?.organization.id).toBe(operation === "refresh" ? "org-a" : "org-b");
  });
});

test("stale not-found recovery cannot open a picker or redirect over a newer selection", async () => {
  await withDashboard(async ({ state, hold, replace }) => {
    const missing = hold("/v1/org", "org-b");
    await act(async () => state().switchOrganization("b"));
    const recovery = hold("/v1/me/orgs");
    await act(async () => missing.resolve({ status: 404, payload: {} }));
    await act(async () => state().switchOrganization("c"));
    replace.mockClear();
    await act(async () => recovery.resolve({ payload: { orgs: [] } }));
    expect(state()).toMatchObject({ orgId: "org-c", orgSelectionOpen: false, orgBusy: false, orgError: null });
    expect(scope.getRequestOrgScope()).toBe("org-c");
    expect(replace).not.toHaveBeenCalled();
  });
});

test("a stale worker-refresh completion cannot clear a newer switch's busy state or navigate", async () => {
  await withDashboard(async ({ state, hold, holdWorkers, replace }) => {
    const workers = holdWorkers();
    await act(async () => state().switchOrganization("b"));
    expect(state().orgContext?.organization.id).toBe("org-b");
    expect(state().orgBusy).toBe(true);
    const next = hold("/v1/org", "org-c");
    await act(async () => state().switchOrganization("c"));
    replace.mockClear();
    await act(async () => workers.resolve());
    expect(state()).toMatchObject({ orgId: "org-c", orgContext: null, orgBusy: true, mutationBusy: "switch-organization" });
    expect(replace).not.toHaveBeenCalled();
    await act(async () => next.resolve(context("org-c")));
    expect(state().orgBusy).toBe(false);
  });
});

test.each(["sign-out", "unmount"])("%s invalidates pending responses and leaves scope empty", async (operation) => {
  await withDashboard(async ({ state, hold, rerender, unmount, replace, calls }) => {
    const refresh = state().refreshOrgData;
    const switchOrganization = state().switchOrganization;
    const next = hold("/v1/org", "org-b");
    await act(async () => state().switchOrganization("b"));
    await act(async () => { if (operation === "sign-out") rerender(null); else unmount(); });
    replace.mockClear();
    await act(async () => next.resolve(context("org-b")));
    expect(scope.getRequestOrgScope()).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    if (operation === "sign-out") expect(state().orgContext).toBeNull();
    const count = calls.length;
    await act(async () => { await refresh(); switchOrganization("c"); });
    expect(calls.length).toBe(count);
    expect(scope.getRequestOrgScope()).toBeNull();
  });
});

test("setup remains pinned despite another tab's active organization and explicit switches", async () => {
  await withDashboard(async ({ state, calls }) => {
    expect(state().orgContext?.organization.id).toBe("org-a");
    expect(scope.getRequestOrgScope()).toBe("org-a");
    const count = calls.length;
    await act(async () => state().switchOrganization("b"));
    expect(calls.length).toBe(count);
    expect(state().orgId).toBe("org-a");
  }, { setupOrganizationId: "org-a", activeOrgId: "org-b" });
});

test("an unavailable setup workspace fails closed instead of falling back to another org", async () => {
  await withDashboard(async ({ state, hold, container }) => {
    const directory = hold("/v1/me/orgs");
    await act(async () => { void state().refreshOrgData(); });
    await act(async () => directory.resolve({ payload: { orgs: orgs.filter((org) => org.id !== "org-a").map((org) => ({ ...org, isActive: org.id === "org-b" })) } }));
    expect(scope.getRequestOrgScope()).toBeNull();
    expect(container.querySelector("[data-gateway]")).toBeNull();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Your setup workspace is unavailable");
    expect(container.textContent).toContain("Retry setup workspace");
  }, { setupOrganizationId: "org-a" });
});

test("single-org deployments continue to ignore explicit switches", async () => {
  await withDashboard(async ({ state, calls }) => {
    const count = calls.length;
    await act(async () => state().switchOrganization("b"));
    expect(calls.length).toBe(count);
    expect(state().orgContext?.organization.id).toBe("org-a");
  }, { singleOrg: true });
});

test.each([false, true])("reauthentication replays only in its original workspace, switching=%s", async (switching) => {
  await withDashboard(async ({ state, verifyReauth }) => {
    const actionScopes: (string | null)[] = [];
    let result: Promise<unknown> | undefined;
    await act(async () => {
      result = state().runReauthableAction("save-inference-provider", async () => {
        actionScopes.push(scope.getRequestOrgScope());
        if (actionScopes.length === 1) throw new requests.ReauthRequiredError("Reauthenticate before changing providers", "fresh_session_required");
      }).catch((error: unknown) => error);
    });
    expect(state().reauthDialogOpen).toBe(true);
    if (switching) await act(async () => state().switchOrganization("b"));
    await act(async () => verifyReauth());
    expect(actionScopes).toEqual(switching ? ["org-a"] : ["org-a", "org-a"]);
    if (switching) expect(await result).toBeInstanceOf(Error);
    else expect(await result).toBeUndefined();
    expect(scope.getRequestOrgScope()).toBe(switching ? "org-b" : "org-a");
  });
});

const unavailableMessage = "This feature is not part of your deployment system, please ask an instance admin to configure deployment";
const unsupportedDeployments = [undefined, null, {}, { version: 1, aiGateway: false }, { version: 2, aiGateway: true }, { version: 1, aiGateway: "true" }];
const gatewayRoutes = [
  "/dashboard/gateway-providers",
  "/dashboard/gateway-providers/new",
  "/dashboard/gateway-providers/infp_1",
  "/dashboard/gateway-providers/infp_1/edit",
];

async function gatewayPage(pathname: string) {
  const params = Promise.resolve({ inferenceProviderId: "infp_1" });
  return pathname.endsWith("/edit") ? await EditGatewayProviderPage({ params })
    : pathname.endsWith("/infp_1") ? await GatewayProviderPage({ params })
    : pathname.endsWith("/new") ? <NewGatewayProviderPage /> : <GatewayProvidersPage />;
}

function featureCalls(calls: { path: string }[]) {
  return calls.filter(({ path }) => /inference|models-dev|llm-providers|catalog|gateway/.test(path));
}

test.each(unsupportedDeployments)("deployment parser fails closed independently of the org opt-in: %j", (deploymentCapabilities) => {
  const orgContext = parseOrgContextPayload(context("org-a", enabledMetadata, "owner", { deploymentCapabilities }).payload);
  expect(orgContext?.capabilities.gatewayDashboard).toBe(true);
  expect(orgContext?.deploymentCapabilities).toEqual({ version: 1, aiGateway: false });
  expect(getGatewayDashboardAccess({ orgId: "org-a", orgContext, orgBusy: false, orgError: null, mutationBusy: null })).toBe("unavailable");
});

test("deployment metadata cannot enable deployment support and deployment support cannot opt an org in", () => {
  const metadata = JSON.stringify({ capabilities: { gatewayDashboard: true }, deploymentCapabilities: { version: 1, aiGateway: true } });
  const orgContext = parseOrgContextPayload(context("org-a", metadata, "owner", {}).payload);
  expect(orgContext?.deploymentCapabilities.aiGateway).toBe(false);
  expect(getGatewayDashboardAccess({ orgId: "org-a", orgContext: parseOrgContextPayload(context("org-a", "{}").payload), orgBusy: false, orgError: null, mutationBusy: null })).toBe("denied");
});

test("access never trusts missing, loading, mismatched or switching context; org errors are not deployment unavailability", () => {
  const ready = { orgId: "org-a", orgContext: parseOrgContextPayload(context("org-a").payload), orgBusy: false, orgError: null, mutationBusy: null };
  for (const state of [
    { ...ready, orgId: null }, { ...ready, orgContext: null }, { ...ready, orgId: "org-b" },
    { ...ready, orgBusy: true }, { ...ready, mutationBusy: "switch-organization" },
  ]) expect(getGatewayDashboardAccess(state)).toBe("checking");
  expect(getGatewayDashboardAccess({ ...ready, orgError: "Failed to load workspace" })).toBe("denied");
});

for (const pathname of gatewayRoutes) {
  test(`${pathname} mounts its real screen and starts feature requests only with effective access`, async () => {
    await withDashboard(async ({ container, calls, replace }) => {
      expect(container.querySelector("[data-testid=gateway-access-state]")).toBeNull();
      expect(featureCalls(calls).length).toBeGreaterThan(0);
      expect(replace).not.toHaveBeenCalled();
    }, { pathname, page: await gatewayPage(pathname), gatewayFailure: true });
  });

  test.each(unsupportedDeployments)(`${pathname} shows the exact deployment notice with no feature requests or management UI for %j`, async (deploymentCapabilities) => {
    await withDashboard(async ({ container, calls, replace }) => {
      expect(container.querySelector("[data-access-state=unavailable]")?.textContent).toBe(unavailableMessage);
      expect(featureCalls(calls)).toEqual([]);
      expect(container.querySelector("button, input, form, [data-testid=gateway-usage]")).toBeNull();
      expect(replace).not.toHaveBeenCalled();
    }, { pathname, page: await gatewayPage(pathname), deploymentCapabilities });
  });

  test(`${pathname} does not mount or fetch while the initial org request is pending`, async () => {
    const initialContext = deferred<Reply>();
    await withDashboard(async ({ container, calls, replace }) => {
      expect(container.querySelector("[data-access-state=checking]")).not.toBeNull();
      expect(container.textContent).not.toContain(unavailableMessage);
      expect(featureCalls(calls)).toEqual([]);
      expect(replace).not.toHaveBeenCalled();
      await act(async () => initialContext.resolve(context("org-a", enabledMetadata, "owner", {})));
      expect(container.textContent).toBe(unavailableMessage);
      expect(featureCalls(calls)).toEqual([]);
    }, { pathname, page: await gatewayPage(pathname), initialContext });
  });

  test(`${pathname} denies nonadmins even when deployment is unavailable`, async () => {
    await withDashboard(async ({ container, calls, replace }) => {
      expect(container.querySelector("[data-access-state=denied]")).not.toBeNull();
      expect(container.textContent).not.toContain(unavailableMessage);
      expect(featureCalls(calls)).toEqual([]);
      expect(replace).toHaveBeenCalledWith("/dashboard");
    }, { pathname, page: await gatewayPage(pathname), role: "member", deploymentCapabilities: undefined });
  });
}

test("a successful deployment capability keeps the real Gateway dashboard available during an upstream outage", async () => {
  await withDashboard(async ({ container, calls, replace }) => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(container.textContent).toContain("Upstream gateway is offline");
    expect(container.textContent).not.toContain(unavailableMessage);
    expect(container.querySelector("[data-testid=gateway-provider-create]")).not.toBeNull();
    expect(calls.some(({ path }) => path.startsWith("/v1/inference-providers/usage?"))).toBe(true);
    expect(replace).not.toHaveBeenCalled();
  }, { page: <GatewayProvidersPage />, gatewayFailure: true });
});

test.each([<GatewayProvidersPage />, <InferencePage />])("real org errors are shown without a deployment notice or redirect", async (page) => {
  const initialContext = deferred<Reply>();
  initialContext.resolve({ status: 503, payload: { message: "Workspace request failed" } });
  await withDashboard(async ({ container, calls, replace }) => {
    expect(container.textContent).toContain("Workspace request failed");
    expect(container.textContent).not.toContain(unavailableMessage);
    expect(featureCalls(calls)).toEqual([]);
    expect(replace).not.toHaveBeenCalled();
  }, { page, initialContext, outsideGateway: page.type === InferencePage });
});

test.each(["gateway", "models"])("the parent admin layout distinguishes a failed org request from loading on %s", async (page) => {
  const initialContext = deferred<Reply>();
  await withDashboard(async ({ container, calls, replace }) => {
    expect(container.querySelector("[data-testid=admin-access-state][data-access-state=checking]")).not.toBeNull();
    await act(async () => initialContext.resolve({ status: 503, payload: { message: "Workspace request failed" } }));
    expect(container.textContent).toContain("Workspace request failed");
    expect(container.querySelector("[data-access-state=checking]")).toBeNull();
    expect(container.textContent).not.toContain(unavailableMessage);
    expect(featureCalls(calls)).toEqual([]);
    expect(replace).not.toHaveBeenCalled();
  }, { outsideGateway: true, initialContext,
    pathname: page === "gateway" ? "/dashboard/gateway-providers" : "/dashboard/inference",
    page: <AdminDashboardLayout>{page === "gateway"
      ? <GatewayProvidersLayout><GatewayProvidersPage /></GatewayProvidersLayout>
      : <InferencePage />}</AdminDashboardLayout> });
});

test("switching between enabled and unavailable deployments unmounts Gateway before scope changes", async () => {
  await withDashboard(async ({ state, hold, container, calls }) => {
    const next = hold("/v1/org", "org-b");
    await act(async () => state().switchOrganization("b"));
    expect(container.querySelector("[data-access-state=checking]")).not.toBeNull();
    await act(async () => next.resolve(context("org-b", enabledMetadata, "owner", {})));
    expect(container.textContent).toBe(unavailableMessage);
    expect(featureCalls(calls)).toEqual([{ path: "/v1/inference-providers?scope=manageable", orgId: "org-a" }]);
    await act(async () => state().switchOrganization("c"));
    expect(container.querySelector("[data-gateway]")).not.toBeNull();
    expect(featureCalls(calls)).toEqual([
      { path: "/v1/inference-providers?scope=manageable", orgId: "org-a" },
      { path: "/v1/inference-providers?scope=manageable", orgId: "org-c" },
    ]);
  });
});

test.each(unsupportedDeployments)("BYOK still works but migration is not mounted for unsupported deployment %j", async (deploymentCapabilities) => {
  await withDashboard(async ({ container, calls }) => {
    expect(container.textContent).toContain("Test BYOK");
    expect(container.textContent).toContain("Edit Provider");
    expect(container.querySelector("[data-testid=llm-provider-move-to-gateway]")).toBeNull();
    expect(container.querySelector("[data-testid=llm-provider-move-to-gateway-confirm]")).toBeNull();
    expect(calls.some(({ path }) => path.startsWith("/v1/inference-providers"))).toBe(false);
  }, { deploymentCapabilities, outsideGateway: true, page: <LlmProviderDetailScreen llmProviderId="llm-1" /> });
});

test.each([
  { name: "self-hosted", metadata: "{}", singleOrg: true, target: "/dashboard/custom-llm-providers" },
  { name: "self-hosted with Gateway", metadata: enabledMetadata, singleOrg: true, target: "/dashboard/custom-llm-providers" },
  { name: "nonadmin", metadata: "{}", role: "member", target: "/dashboard" },
  { name: "nonadmin with Gateway", metadata: enabledMetadata, role: "member", target: "/dashboard" },
  { name: "runtime checking", metadata: "{}", runtimeConfigLoaded: false, target: null },
  { name: "runtime checking with Gateway", metadata: enabledMetadata, runtimeConfigLoaded: false, target: null },
])("Models direct URL blocks $name before inference fetches or checkout controls mount", async ({ target, ...options }) => {
  await withDashboard(async ({ container, calls, replace }) => {
    expect(featureCalls(calls)).toEqual([]);
    expect(container.textContent).not.toContain("Manage subscription");
    expect(container.querySelector("button")).toBeNull();
    if (target) expect(replace).toHaveBeenCalledWith(target);
    else expect(replace).not.toHaveBeenCalled();
  }, { ...options, pathname: "/dashboard/inference", outsideGateway: true, page: <InferencePage /> });
});

test.each(["admin", "super-admin", "owner"])("hosted %s mounts the real Models page alongside an effectively enabled Gateway", async (role) => {
  await withDashboard(async ({ state, container, calls, replace }) => {
    expect(getGatewayDashboardAccess(state())).toBe("enabled");
    expect(container.querySelector("[data-testid=models-access-state]")).toBeNull();
    expect(calls.filter(({ path }) => path === "/v1/inference")).toHaveLength(1);
    expect(calls.some(({ path }) => path.startsWith("/v1/inference-providers"))).toBe(false);
    expect(container.querySelector("h1")?.textContent).toBe("OpenWork Models");
    expect(container.textContent).toContain("Manage subscription");
    expect(container.querySelector("table")).not.toBeNull();
    expect(replace).not.toHaveBeenCalled();
  }, { role, pathname: "/dashboard/inference", outsideGateway: true,
    page: <AdminDashboardLayout><InferencePage /></AdminDashboardLayout> });
});

test.each([
  { metadata: "{}", deploymentCapabilities: { version: 1, aiGateway: true } },
  { metadata: "{}", deploymentCapabilities: undefined },
  { metadata: enabledMetadata, deploymentCapabilities: { version: 1, aiGateway: false } },
  { metadata: enabledMetadata, deploymentCapabilities: { version: 2, aiGateway: true } },
])("hosted Models remains unchanged outside an effectively enabled Gateway: %j", async (options) => {
  await withDashboard(async ({ container, calls, replace }) => {
    expect(calls.filter(({ path }) => path === "/v1/inference")).toHaveLength(1);
    expect(container.textContent).toContain("OpenWork Models");
    expect(container.textContent).toContain("Manage subscription");
    expect(replace).not.toHaveBeenCalled();
  }, { ...options, pathname: "/dashboard/inference", outsideGateway: true, page: <InferencePage /> });
});

test("Models waits for context and survives hosted-to-gateway-to-hosted switches without leaking requests or controls", async () => {
  const initialContext = deferred<Reply>();
  await withDashboard(async ({ state, hold, container, calls, replace }) => {
    expect(container.querySelector("[data-access-state=checking]")).not.toBeNull();
    expect(featureCalls(calls)).toEqual([]);
    await act(async () => initialContext.resolve(context("org-a", "{}")));
    expect(container.textContent).toContain("Manage subscription");
    const next = hold("/v1/org", "org-b");
    await act(async () => state().switchOrganization("b"));
    expect(container.textContent).not.toContain("Manage subscription");
    expect(container.querySelector("[data-access-state=checking]")).not.toBeNull();
    expect(calls.filter(({ path }) => path === "/v1/inference")).toHaveLength(1);
    await act(async () => next.resolve(context("org-b")));
    expect(getGatewayDashboardAccess(state())).toBe("enabled");
    expect(container.textContent).toContain("Manage subscription");
    expect(calls.filter(({ path }) => path === "/v1/inference")).toHaveLength(2);
    const last = hold("/v1/org", "org-c");
    await act(async () => state().switchOrganization("c"));
    expect(container.textContent).not.toContain("Manage subscription");
    expect(container.querySelector("[data-access-state=checking]")).not.toBeNull();
    expect(calls.filter(({ path }) => path === "/v1/inference")).toHaveLength(2);
    await act(async () => last.resolve(context("org-c", "{}")));
    expect(container.textContent).toContain("Manage subscription");
    expect(calls.filter(({ path }) => path === "/v1/inference")).toHaveLength(3);
    expect(calls.some(({ path }) => path.startsWith("/v1/inference-providers"))).toBe(false);
    expect(replace).not.toHaveBeenCalledWith("/dashboard/gateway-providers");
  }, { pathname: "/dashboard/inference", outsideGateway: true, page: <InferencePage />, initialContext });
});
