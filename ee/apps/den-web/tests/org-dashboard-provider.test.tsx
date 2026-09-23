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
import AiGatewayProvidersLayout from "../app/(den)/dashboard/(admin)/ai-gateway/providers/layout";
import { GatewayDashboardCapabilityGuard } from "../app/(den)/dashboard/_components/gateway-dashboard-capability-guard";
import AdminDashboardLayout from "../app/(den)/dashboard/(admin)/layout";
import AiGatewayPage from "../app/(den)/dashboard/(admin)/ai-gateway/page";
import StripeCheckingPage from "../app/(den)/dashboard/(admin)/billing/stripe/checking/page";
import { INFERENCE_MODEL_ALIASES } from "@openwork/types/den/inference";
import NewGatewayProviderPage from "../app/(den)/dashboard/(admin)/ai-gateway/providers/new/page";
import GatewayProviderPage from "../app/(den)/dashboard/(admin)/ai-gateway/providers/[inferenceProviderId]/page";
import EditGatewayProviderPage from "../app/(den)/dashboard/(admin)/ai-gateway/providers/[inferenceProviderId]/edit/page";
import { useOrgInferenceProviders } from "../app/(den)/dashboard/_components/inference-provider-data";
import { LlmProviderDetailScreen } from "../app/(den)/dashboard/_components/llm-provider-detail-screen";
import { parseOrgContextPayload } from "../app/(den)/_lib/den-org";
import { getGatewayDashboardAccess } from "../app/(den)/dashboard/_lib/gateway-dashboard-access";

type Reply = { payload: unknown; status?: number };
const account = { id: "user-1", name: "Member", email: "member@example.test" };
const orgs = ["a", "b", "c"].map((key) => ({
  id: `org-${key}`, name: `Workspace ${key}`, slug: key, role: "owner",
  orgMemberId: `member-${key}`, membershipId: `membership-${key}`,
}));

function context(id: string, metadata = "{}", role = "owner", deployment: { deploymentCapabilities?: unknown } = { deploymentCapabilities: { version: 1, aiGateway: true } }): Reply {
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
  push: ReturnType<typeof mock<(path: string) => void>>;
  rerender: (user: typeof account | null) => void;
  unmount: () => void;
  verifyReauth: () => Promise<void>;
}) => Promise<void>, options: {
  setupOrganizationId?: string; activeOrgId?: string; singleOrg?: boolean; metadata?: string; role?: string;
  page?: ReactNode; pathname?: string; outsideGateway?: boolean; deploymentCapabilities?: unknown;
  runtimeConfigLoaded?: boolean; initialContext?: ReturnType<typeof deferred<Reply>>; gatewayFailure?: boolean;
  providerAvailable?: boolean;
  reply?: (path: string, init?: RequestInit) => Reply | undefined;
} = {}) {
  GlobalRegistrator.register({ url: `https://app.example.test${options.pathname ?? "/dashboard/org-settings"}` });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
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
  const push = mock((_path: string) => {});
  let verifyReauth: () => Promise<void> = async () => { throw new Error("Reauth dialog not mounted"); };
  const RealReauthDialog = reauth.ReauthDialog;
  spyOn(reauth, "ReauthDialog").mockImplementation((props) => {
    verifyReauth = props.onVerified;
    return <RealReauthDialog {...props} />;
  });
  const config = { ...runtime.EMPTY_RUNTIME_CONFIG, orgMode: options.singleOrg ? "single_org" : "multi_org" } satisfies runtime.DenWebRuntimeConfig;
  const useRealDenFlow = flow.useDenFlow;
  const setScope = scope.setRequestOrgScope;
  const refreshWorkers = async () => { await workers?.promise; };
  spyOn(scope, "setRequestOrgScope").mockImplementation((id) => {
    scopeWrites.push({ id, busy: current?.orgBusy, contextId: current?.orgContext?.organization.id,
      gatewayMounted: Boolean(container.querySelector("[data-gateway]")) });
    setScope(id);
  });
  const url = new URL(options.pathname ?? "/dashboard/org-settings", "https://app.example.test");
  spyOn(navigation, "usePathname").mockReturnValue(url.pathname);
  spyOn(navigation, "useSearchParams").mockReturnValue(new navigation.ReadonlyURLSearchParams(url.search));
  spyOn(navigation, "useRouter").mockReturnValue({ push, replace, refresh() {}, back() {}, forward() {}, prefetch: async () => {}, bfcacheId: "fixture" });
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
    const override = options.reply?.(path, init);
    const reply: Reply = held ? await held.promise : override ?? (path === "/v1/me/orgs"
      ? { payload: { orgs: orgs.map((org) => ({ ...org, isActive: org.id === activeOrgId })) } }
      : path === "/v1/org" ? options.initialContext ? await options.initialContext.promise
        : context(orgId ?? "missing", options.metadata, options.role, "deploymentCapabilities" in options ? { deploymentCapabilities: options.deploymentCapabilities } : undefined)
      : options.gatewayFailure && path.startsWith("/v1/inference-providers") ? { status: 503, payload: { message: "Upstream gateway is offline" } }
      : options.providerAvailable && path === "/v1/inference-providers?scope=manageable" ? { payload: { inferenceProviders: [{
        id: "infp_1", providerId: "openai", name: "Fixture Provider", credentialMode: "org", status: "active", modelIds: [],
      }] } }
      : path === "/v1/inference" ? { payload: { inference: { enabled: true, tier: "tier1", subscribed: true } } }
      : path.startsWith("/v1/llm-providers?") ? { payload: { llmProviders: [{
        id: "llm-1", name: "Test BYOK", organizationId: activeOrgId, createdByOrgMembershipId: "member-a",
        source: "models_dev", providerId: "openai", canManage: true, hasApiKey: true,
        providerConfig: {}, models: [], access: {}, accessibleVia: {},
      }] } }
      : { payload: path === "/v1/me" ? { user: account } : {} });
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
    return options.outsideGateway ? options.page : <GatewayDashboardCapabilityGuard>{options.page ?? <ScopedConsumer />}</GatewayDashboardCapabilityGuard>;
  }
  const render = () => root.render(<QueryClientProvider client={queryClient}><flow.DenFlowProvider><OrgDashboardProvider><Capture /></OrgDashboardProvider></flow.DenFlowProvider></QueryClientProvider>);
  try {
    await act(async () => render());
    await check({
      state: () => { if (!current) throw new Error("Dashboard not mounted"); return current; },
      container, calls, scopeWrites, unmountedScopes, replace, push,
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
    await act(async () => next.resolve(context("org-b")));
    expect(state()).toMatchObject({ orgId: "org-b", orgBusy: false, orgError: null, mutationBusy: null });
    expect(state().orgContext?.organization.id).toBe("org-b");
    expect(container.querySelector("[data-gateway]")).not.toBeNull();
    expect(calls.filter((call) => call.path.startsWith("/v1/inference-providers"))).toEqual([
      { path: "/v1/inference-providers?scope=manageable", orgId: "org-a" },
      { path: "/v1/inference-providers?scope=manageable", orgId: "org-b" },
    ]);
  });
});

test.each([
  "/dashboard/ai-gateway/providers/new",
  "/dashboard/ai-gateway/providers/infp_1",
  "/dashboard/ai-gateway/providers/infp_1/edit",
])("unauthorized direct route %s redirects without mounting its real screen or fetching providers", async (pathname) => {
  const page = await gatewayPage(pathname);
  await withDashboard(async ({ container, calls, replace }) => {
    expect(container.querySelector("[data-testid=admin-access-state][data-access-state=redirecting]")).not.toBeNull();
    expect(replace).toHaveBeenCalledWith("/dashboard");
    expect(calls.some((call) => call.path.startsWith("/v1/inference-providers"))).toBe(false);
    expect(featureCalls(calls)).toEqual([]);
    expect(container.querySelector("[data-testid=gateway-provider-create]")).toBeNull();
  }, { role: "member", pathname, page, outsideGateway: true });
});

test.each(["admin", "super-admin", "owner", "member", "qa-reviewer"])("configured deployment retains %s permissions", async (role) => {
  await withDashboard(async ({ container, calls, replace }) => {
    const enabled = ["admin", "super-admin", "owner"].includes(role);
    expect(Boolean(container.querySelector("[data-gateway]"))).toBe(enabled);
    expect(calls.some((call) => call.path.startsWith("/v1/inference-providers"))).toBe(enabled);
    if (!enabled) expect(replace).toHaveBeenCalledWith("/dashboard");
  }, { role });
});

test("unauthorized-to-admin switch waits for the selected org and fetches only that org", async () => {
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
  }, { role: "member" });
});

const legacyGatewayMetadata = [
  "{}", '{"capabilities":null}', '{"capabilities":false}',
  '{"capabilities":{"gatewayDashboard":true}}', '{"capabilities":{"gatewayDashboard":false}}',
  '{"capabilities":{"gatewayDashboard":"true"}}', '{"capabilities":{"gatewayDashboard":1}}',
];

test.each(legacyGatewayMetadata)("configured admins retain BYOK migration regardless of retired metadata: %s", async (metadata) => {
  await withDashboard(async ({ container, calls, state, hold }) => {
    expect(container.textContent).toContain("Test BYOK");
    expect(container.textContent).toContain("Edit Provider");
    const button = container.querySelector<HTMLButtonElement>("[data-testid=llm-provider-move-to-gateway]");
    expect(button).not.toBeNull();
    expect(calls.some((call) => call.path.startsWith("/v1/inference-providers"))).toBe(false);
    await act(async () => button?.click());
    expect(container.querySelector("[data-testid=llm-provider-move-to-gateway-confirm]")).not.toBeNull();
    const next = hold("/v1/org", "org-b");
    await act(async () => state().switchOrganization("b"));
    expect(container.querySelector("[data-testid=llm-provider-move-to-gateway-confirm]")).toBeNull();
    expect(container.querySelector("[data-testid=llm-provider-move-to-gateway]")).toBeNull();
    await act(async () => next.resolve(context("org-b", metadata)));
    expect(container.querySelector("[data-testid=llm-provider-move-to-gateway]")).not.toBeNull();
    expect(container.querySelector("[data-testid=llm-provider-move-to-gateway-confirm]")).toBeNull();
  }, { metadata, outsideGateway: true, page: <LlmProviderDetailScreen llmProviderId="llm-1" /> });
});

test.each(legacyGatewayMetadata)("parser and real guard ignore retired Gateway metadata: %s", async (metadata) => {
  for (const role of ["admin", "super-admin", "owner", "admin, qa-reviewer"]) {
    const orgContext = parseOrgContextPayload(context("org-a", metadata, role).payload);
    expect(orgContext?.capabilities).not.toHaveProperty("gatewayDashboard");
    expect(getGatewayDashboardAccess({ orgId: "org-a", orgContext, orgBusy: false, orgError: null, mutationBusy: null })).toBe("enabled");
  }
  await withDashboard(async ({ container, state, calls }) => {
    expect(getGatewayDashboardAccess(state())).toBe("enabled");
    expect(container.querySelector("[data-gateway]")).not.toBeNull();
    expect(calls.filter((call) => call.path.startsWith("/v1/inference-providers"))).toEqual([
      { path: "/v1/inference-providers?scope=manageable", orgId: "org-a" },
    ]);
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

test("overlapping refreshes keep the latest busy state and authorization result", async () => {
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
    await act(async () => { next.resolve(context("org-a", "{}", "member")); await second; });
    expect(state().orgBusy).toBe(false);
    expect(state().orgContext?.currentMember.role).toBe("member");
    expect(container.querySelector("[data-gateway]")).toBeNull();
  });
});

test("a refresh clears busy when the org context loads, without waiting for workers", async () => {
  await withDashboard(async ({ state, hold, holdWorkers }) => {
    const workers = holdWorkers();
    const next = hold("/v1/org", "org-a");
    await act(async () => { void state().refreshOrgData(); });
    expect(state().orgBusy).toBe(true);
    await act(async () => next.resolve(context("org-a")));
    expect(state()).toMatchObject({ orgBusy: false, orgError: null });
    expect(state().orgContext?.organization.id).toBe("org-a");
    await act(async () => workers.resolve());
    expect(state().orgBusy).toBe(false);
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
  "/dashboard/ai-gateway/providers/new",
  "/dashboard/ai-gateway/providers/infp_1",
  "/dashboard/ai-gateway/providers/infp_1/edit",
];

async function gatewayPage(pathname: string) {
  const params = Promise.resolve({ inferenceProviderId: "infp_1" });
  const page = pathname.endsWith("/edit") ? await EditGatewayProviderPage({ params })
    : pathname.endsWith("/infp_1") ? await GatewayProviderPage({ params })
    : await NewGatewayProviderPage({ searchParams: Promise.resolve({}) });
  return <AdminDashboardLayout><AiGatewayProvidersLayout>{page}</AiGatewayProvidersLayout></AdminDashboardLayout>;
}

function featureCalls(calls: { path: string }[]) {
  return calls.filter(({ path }) => /inference|models-dev|llm-providers|catalog|gateway/.test(path));
}

test.each(unsupportedDeployments)("deployment parser still fails closed without supported configuration: %j", (deploymentCapabilities) => {
  for (const metadata of legacyGatewayMetadata) {
    const orgContext = parseOrgContextPayload(context("org-a", metadata, "owner", { deploymentCapabilities }).payload);
    expect(orgContext?.deploymentCapabilities).toEqual({ version: 1, aiGateway: false });
    expect(getGatewayDashboardAccess({ orgId: "org-a", orgContext, orgBusy: false, orgError: null, mutationBusy: null })).toBe("unavailable");
  }
});

test("organization metadata cannot enable deployment support", () => {
  const metadata = JSON.stringify({ deploymentCapabilities: { version: 1, aiGateway: true } });
  const orgContext = parseOrgContextPayload(context("org-a", metadata, "owner", {}).payload);
  expect(orgContext?.deploymentCapabilities.aiGateway).toBe(false);
  expect(getGatewayDashboardAccess({ orgId: "org-a", orgContext, orgBusy: false, orgError: null, mutationBusy: null })).toBe("unavailable");
});

test.each(["member", "qa-reviewer"])("retired metadata never authorizes %s", (role) => {
  for (const metadata of legacyGatewayMetadata) {
    for (const deploymentCapabilities of [{ version: 1, aiGateway: true }, ...unsupportedDeployments]) {
      const orgContext = parseOrgContextPayload(context("org-a", metadata, role, { deploymentCapabilities }).payload);
      expect(getGatewayDashboardAccess({ orgId: "org-a", orgContext, orgBusy: false, orgError: null, mutationBusy: null })).toBe("denied");
    }
  }
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
    }, { pathname, outsideGateway: true, page: await gatewayPage(pathname), gatewayFailure: true });
  });

  test.each(unsupportedDeployments)(`${pathname} shows the exact deployment notice with no feature requests or management UI for %j`, async (deploymentCapabilities) => {
    await withDashboard(async ({ container, calls, replace }) => {
      expect(container.querySelector("[data-access-state=unavailable]")?.textContent).toBe(unavailableMessage);
      expect(featureCalls(calls)).toEqual([]);
      expect(container.querySelector('[role="tabpanel"]')?.querySelector("button, input, form, [data-testid=gateway-usage]")).toBeNull();
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(5);
      expect(replace).not.toHaveBeenCalled();
    }, { pathname, outsideGateway: true, page: await gatewayPage(pathname), deploymentCapabilities });
  });

  test(`${pathname} does not mount or fetch while the initial org request is pending`, async () => {
    const initialContext = deferred<Reply>();
    await withDashboard(async ({ container, calls, replace }) => {
      expect(container.querySelector("[data-access-state=checking]")).not.toBeNull();
      expect(container.textContent).not.toContain(unavailableMessage);
      expect(featureCalls(calls)).toEqual([]);
      expect(replace).not.toHaveBeenCalled();
      await act(async () => initialContext.resolve(context("org-a", "{}", "owner", {})));
      expect(container.querySelector("[data-access-state=unavailable]")?.textContent).toBe(unavailableMessage);
      expect(featureCalls(calls)).toEqual([]);
    }, { pathname, outsideGateway: true, page: await gatewayPage(pathname), initialContext });
  });

  test(`${pathname} denies nonadmins even when deployment is unavailable`, async () => {
    await withDashboard(async ({ container, calls, replace }) => {
      expect(container.querySelector("[data-testid=admin-access-state][data-access-state=redirecting]")).not.toBeNull();
      expect(container.textContent).not.toContain(unavailableMessage);
      expect(featureCalls(calls)).toEqual([]);
      expect(replace).toHaveBeenCalledWith("/dashboard");
    }, { pathname, outsideGateway: true, page: await gatewayPage(pathname), role: "member", deploymentCapabilities: undefined });
  });
}

for (const tab of ["overview", "ai-providers"]) {
  const pathname = `/dashboard/ai-gateway?tab=${tab}`;
  const page = <AdminDashboardLayout><AiGatewayPage /></AdminDashboardLayout>;

  test(`${tab} keeps the canonical shell available during an upstream outage`, async () => {
    await withDashboard(async ({ container, calls, replace }) => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      expect(container.textContent).toContain("Upstream gateway is offline");
      expect(container.textContent).not.toContain(unavailableMessage);
      expect(Boolean(container.querySelector("[data-testid=gateway-provider-create]"))).toBe(tab === "ai-providers");
      expect(calls.some(({ path }) => path.startsWith("/v1/inference-providers/usage?"))).toBe(false);
      expect(replace).not.toHaveBeenCalled();
    }, { pathname, page, outsideGateway: true, gatewayFailure: true });
  });

  test.each(unsupportedDeployments)(`${tab} blocks gateway requests without deployment support: %j`, async (deploymentCapabilities) => {
    await withDashboard(async ({ container, calls, replace }) => {
      expect(container.textContent).toContain(unavailableMessage);
      expect(calls.some(({ path }) => /inference|models-dev|gateway/.test(path))).toBe(false);
      expect(container.querySelector("[data-testid=gateway-provider-create], [data-testid=gateway-usage]")).toBeNull();
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(5);
      expect(replace).not.toHaveBeenCalled();
    }, { pathname, page, outsideGateway: true, deploymentCapabilities });
  });

  test(`${tab} waits for context and rejects nonadmins before any feature request`, async () => {
    const initialContext = deferred<Reply>();
    await withDashboard(async ({ container, calls, replace }) => {
      expect(container.querySelector("[data-access-state=checking]")).not.toBeNull();
      expect(featureCalls(calls)).toEqual([]);
      expect(replace).not.toHaveBeenCalled();
      await act(async () => initialContext.resolve(context("org-a", "{}", "member")));
      expect(container.querySelector("[data-testid=admin-access-state][data-access-state=redirecting]")).not.toBeNull();
      expect(featureCalls(calls)).toEqual([]);
      expect(replace).toHaveBeenCalledWith("/dashboard");
    }, { pathname, page, outsideGateway: true, initialContext });
  });

  test(`${tab} unmounts gateway controls during org switching and cannot fetch without deployment support`, async () => {
    await withDashboard(async ({ container, calls, state, hold }) => {
      const next = hold("/v1/org", "org-b");
      await act(async () => state().switchOrganization("b"));
      expect(container.querySelector("[data-access-state=checking]")).not.toBeNull();
      expect(container.querySelector("[data-testid=gateway-provider-create], [data-testid=gateway-usage]")).toBeNull();
      await act(async () => next.resolve(context("org-b", "{}", "owner", {})));
      expect(container.textContent).toContain(unavailableMessage);
      expect(calls.filter(({ path, orgId }) => path.startsWith("/v1/inference-providers") && orgId !== "org-a")).toEqual([]);
    }, { pathname, page, outsideGateway: true, providerAvailable: true });
  });
}

test("Overview alone fetches usage after providers load; AI Providers links stay canonical", async () => {
  for (const tab of ["overview", "ai-providers"]) {
    await withDashboard(async ({ container, calls }) => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      expect(calls.some(({ path }) => path.startsWith("/v1/inference-providers/usage?"))).toBe(tab === "overview");
      if (tab === "ai-providers") {
        expect(container.querySelector('[data-testid="gateway-provider-create"]')?.getAttribute("href")).toBe("/dashboard/ai-gateway/providers/new");
        expect(container.querySelector('[data-testid="gateway-provider-open"]')?.getAttribute("href")).toBe("/dashboard/ai-gateway/providers/infp_1");
      }
    }, { pathname: `/dashboard/ai-gateway?tab=${tab}`, page: <AdminDashboardLayout><AiGatewayPage /></AdminDashboardLayout>, outsideGateway: true, providerAvailable: true });
  }
});

test.each(["overview", "openwork-models"])("real org errors on %s are shown without a deployment notice or redirect", async (tab) => {
  const initialContext = deferred<Reply>();
  initialContext.resolve({ status: 503, payload: { message: "Workspace request failed" } });
  await withDashboard(async ({ container, calls, replace }) => {
    expect(container.textContent).toContain("Workspace request failed");
    expect(container.textContent).not.toContain(unavailableMessage);
    expect(featureCalls(calls)).toEqual([]);
    expect(replace).not.toHaveBeenCalled();
  }, { page: <AiGatewayPage />, pathname: `/dashboard/ai-gateway?tab=${tab}`, initialContext, outsideGateway: true });
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
    pathname: page === "gateway" ? "/dashboard/ai-gateway" : "/dashboard/ai-gateway?tab=openwork-models",
    page: <AdminDashboardLayout><AiGatewayPage /></AdminDashboardLayout> });
});

test("switching between enabled and unavailable deployments unmounts Gateway before scope changes", async () => {
  await withDashboard(async ({ state, hold, container, calls }) => {
    const next = hold("/v1/org", "org-b");
    await act(async () => state().switchOrganization("b"));
    expect(container.querySelector("[data-access-state=checking]")).not.toBeNull();
    await act(async () => next.resolve(context("org-b", "{}", "owner", {})));
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

test.each([
  { source: "models_dev", canManage: true, credentialMode: "per_member", role: "owner" },
  { source: "models_dev", canManage: false, credentialMode: "shared", role: "owner" },
  { source: "custom", canManage: true, credentialMode: "shared", role: "owner" },
  { source: "openwork", canManage: true, credentialMode: "shared", role: "owner" },
  { source: "models_dev", canManage: true, credentialMode: "shared", role: "member" },
])("BYOK migration retains source, management, credential and role restrictions: %j", async ({ role, ...provider }) => {
  await withDashboard(async ({ container, calls }) => {
    expect(container.textContent).toContain("Restricted BYOK");
    expect(container.querySelector("[data-testid=llm-provider-move-to-gateway]")).toBeNull();
    expect(container.querySelector("[data-testid=llm-provider-move-to-gateway-confirm]")).toBeNull();
    expect(calls.some(({ path }) => path.includes("migrate") || path.startsWith("/v1/inference-providers"))).toBe(false);
  }, { role, outsideGateway: true, page: <LlmProviderDetailScreen llmProviderId="llm-1" />,
    reply: (path) => path.startsWith("/v1/llm-providers?") ? { payload: { llmProviders: [{
      id: "llm-1", name: "Restricted BYOK", organizationId: "org-a", createdByOrgMembershipId: "member-a",
      providerId: "openai", hasApiKey: true, providerConfig: {}, models: [], access: {}, accessibleVia: {}, ...provider,
    }] } } : undefined,
  });
});

test.each(["member", "unavailable"])("BYOK migration confirmation closes when the next workspace is %s", async (nextAccess) => {
  await withDashboard(async ({ container, state, hold, calls }) => {
    const button = container.querySelector<HTMLButtonElement>("[data-testid=llm-provider-move-to-gateway]");
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(container.querySelector("[data-testid=llm-provider-move-to-gateway-confirm]")).not.toBeNull();
    const next = hold("/v1/org", "org-b");
    await act(async () => state().switchOrganization("b"));
    expect(container.querySelector("[data-testid=llm-provider-move-to-gateway-confirm]")).toBeNull();
    await act(async () => next.resolve(nextAccess === "member" ? context("org-b", "{}", "member") : context("org-b", "{}", "owner", {})));
    expect(container.querySelector("[data-testid=llm-provider-move-to-gateway]")).toBeNull();
    expect(container.querySelector("[data-testid=llm-provider-move-to-gateway-confirm]")).toBeNull();
    expect(calls.some(({ path }) => path.includes("migrate"))).toBe(false);
  }, { outsideGateway: true, page: <LlmProviderDetailScreen llmProviderId="llm-1" /> });
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
  { name: "self-hosted without Gateway", deploymentCapabilities: undefined, singleOrg: true, target: "/dashboard/custom-llm-providers" },
  { name: "self-hosted with Gateway", singleOrg: true, target: "/dashboard/custom-llm-providers" },
  { name: "nonadmin without Gateway", deploymentCapabilities: undefined, role: "member", target: "/dashboard" },
  { name: "nonadmin with Gateway", role: "member", target: "/dashboard" },
  { name: "runtime checking without Gateway", deploymentCapabilities: undefined, runtimeConfigLoaded: false, target: null },
  { name: "runtime checking with Gateway", runtimeConfigLoaded: false, target: null },
])("Models direct URL blocks $name before inference fetches or checkout controls mount", async ({ target, ...options }) => {
  await withDashboard(async ({ container, calls, replace }) => {
    expect(featureCalls(calls)).toEqual([]);
    expect(container.textContent).not.toContain("Manage subscription");
    expect(container.querySelector('[data-testid="ai-gateway-panel-openwork-models"] button')).toBeNull();
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(5);
    if (target) expect(replace).toHaveBeenCalledWith(target);
    else expect(replace).not.toHaveBeenCalled();
  }, { ...options, pathname: "/dashboard/ai-gateway?tab=openwork-models", outsideGateway: true, page: <AiGatewayPage /> });
});

test.each(["admin", "super-admin", "owner"])("hosted %s mounts the real Models page alongside an effectively enabled Gateway", async (role) => {
  await withDashboard(async ({ state, container, calls, replace }) => {
    expect(getGatewayDashboardAccess(state())).toBe("enabled");
    expect(container.querySelector("[data-testid=models-access-state]")).toBeNull();
    expect(calls.filter(({ path }) => path === "/v1/inference")).toHaveLength(1);
    expect(calls.some(({ path }) => path.startsWith("/v1/inference-providers"))).toBe(false);
    expect([...container.querySelectorAll("h1")].map((heading) => heading.textContent)).toEqual(["AI Gateway"]);
    expect(container.querySelectorAll("[data-dashboard-hero]")).toHaveLength(1);
    const panel = container.querySelector('[data-testid="ai-gateway-panel-openwork-models"]');
    expect(panel?.querySelector("h2")?.textContent).toBe("OpenWork Models");
    expect(panel?.firstElementChild?.className).toBe("grid gap-6");
    expect(panel?.textContent).toContain("Reliable, hand-picked models for knowledge work. No API keys to manage.");
    expect(panel?.textContent).toContain("$10 / user / month");
    expect(panel?.querySelector('a[href="/dashboard/custom-llm-providers"]')?.textContent).toBe("Set up Bring your Own Keys.");
    expect(container.textContent).toContain("Manage subscription");
    expect(container.querySelector("table")).not.toBeNull();
    expect(replace).not.toHaveBeenCalled();
  }, { role, pathname: "/dashboard/ai-gateway?tab=openwork-models", outsideGateway: true,
    page: <AdminDashboardLayout><AiGatewayPage /></AdminDashboardLayout> });
});

test.each([
  { metadata: "{}", deploymentCapabilities: { version: 1, aiGateway: true } },
  { metadata: "{}", deploymentCapabilities: undefined },
  { metadata: "{}", deploymentCapabilities: { version: 1, aiGateway: false } },
  { metadata: "{}", deploymentCapabilities: { version: 2, aiGateway: true } },
])("hosted Models remains independent of Gateway deployment availability: %j", async (options) => {
  await withDashboard(async ({ container, calls, replace }) => {
    expect(calls.filter(({ path }) => path === "/v1/inference")).toHaveLength(1);
    expect(container.textContent).toContain("OpenWork Models");
    expect(container.textContent).toContain("Manage subscription");
    expect(replace).not.toHaveBeenCalled();
  }, { ...options, pathname: "/dashboard/ai-gateway?tab=openwork-models", outsideGateway: true, page: <AiGatewayPage /> });
});

test("Models waits for context and survives hosted-to-gateway-to-hosted switches without leaking requests or controls", async () => {
  const initialContext = deferred<Reply>();
  await withDashboard(async ({ state, hold, container, calls, replace }) => {
    expect(container.querySelector("[data-access-state=checking]")).not.toBeNull();
    expect(featureCalls(calls)).toEqual([]);
    await act(async () => initialContext.resolve(context("org-a", "{}", "owner", {})));
    expect(getGatewayDashboardAccess(state())).toBe("unavailable");
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
    await act(async () => last.resolve(context("org-c", "{}", "owner", {})));
    expect(getGatewayDashboardAccess(state())).toBe("unavailable");
    expect(container.textContent).toContain("Manage subscription");
    expect(calls.filter(({ path }) => path === "/v1/inference")).toHaveLength(3);
    expect(calls.some(({ path }) => path.startsWith("/v1/inference-providers"))).toBe(false);
    expect(replace).not.toHaveBeenCalledWith("/dashboard/ai-gateway");
    expect(replace).not.toHaveBeenCalledWith("/dashboard/ai-gateway?tab=ai-providers");
  }, { pathname: "/dashboard/ai-gateway?tab=openwork-models", outsideGateway: true, page: <AiGatewayPage />, initialContext });
});

test.each([
  { enabled: false, subscribed: false, action: "Subscribe" },
  { enabled: false, subscribed: true, action: "Enable" },
  { enabled: true, subscribed: true, action: "Manage subscription" },
])("Models tab retains the lineup, usage and $action flow using only mocked APIs", async ({ enabled, subscribed, action }) => {
  const writes: { path: string; method: string; body: unknown }[] = [];
  const buckets = ["five_hour", "weekly", "monthly"].map((windowType) => ({
    windowType, windowStartAt: "2026-09-01T00:00:00Z", windowEndAt: "2026-10-01T00:00:00Z", limitAmount: 100, usedAmount: 25,
  }));
  let currentEnabled = enabled;
  await withDashboard(async ({ container, calls, push }) => {
    const panel = container.querySelector('[data-testid="ai-gateway-panel-openwork-models"]');
    expect(panel?.textContent).toContain("$10 / user / month · 3 active members");
    expect(panel?.textContent?.includes("One subscription activates models for everyone in your workspace.")).toBe(!subscribed);
    expect(panel?.querySelectorAll('[role="progressbar"]')).toHaveLength(enabled ? 3 : 0);
    if (enabled) {
      expect([...container.querySelectorAll('[role="progressbar"]')].map((meter) => [meter.getAttribute("aria-label"), meter.getAttribute("aria-valuenow")])).toEqual([
        ["5 hour usage limit remaining", "75"], ["Weekly usage limit remaining", "75"], ["Monthly usage limit remaining", "75"],
      ]);
    }
    const lineup = Object.entries(INFERENCE_MODEL_ALIASES).filter(([, model]) => model.enabled);
    expect(panel?.querySelectorAll("tbody tr")).toHaveLength(lineup.length);
    for (const [id, model] of lineup) {
      expect(panel?.textContent).toContain(id);
      expect(panel?.textContent).toContain(model.displayName.replace(/^OpenWork:\s*/, ""));
    }
    const button = [...container.querySelectorAll("button")].find((button) => button.textContent === action);
    if (!button) throw new Error(`Missing Models action: ${action}`);
    expect(button.disabled).toBe(false);
    expect(writes).toEqual([]);
    await act(async () => button.click());
    if (!subscribed) {
      expect(writes).toEqual([{ path: "/v1/billing/stripe/checkout", method: "POST", body: { type: "inference" } }]);
      expect(window.location.hash).toBe("#mock-checkout");
    } else if (!enabled) {
      expect(writes).toEqual([{ path: "/v1/inference", method: "PATCH", body: { enabled: true, tier: "tier1" } }]);
      expect(container.textContent).toContain("Manage subscription");
      expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(3);
    } else {
      expect(push).toHaveBeenCalledWith("/dashboard/billing");
      expect(writes).toEqual([]);
    }
    expect(calls.some(({ path }) => path.startsWith("/v1/inference-providers") || path.startsWith("/v1/gateway"))).toBe(false);
  }, {
    pathname: "/dashboard/ai-gateway?tab=openwork-models", outsideGateway: true, page: <AiGatewayPage />, metadata: "{}",
    reply(path, init) {
      if (init?.method === "POST" || init?.method === "PATCH") {
        writes.push({ path, method: init.method, body: JSON.parse(String(init.body)) });
        if (path === "/v1/billing/stripe/checkout") return { payload: { url: "#mock-checkout" } };
        if (path === "/v1/inference") currentEnabled = true;
      }
      if (path === "/v1/inference") return { payload: { inference: { enabled: currentEnabled, subscribed, tier: "tier1", memberCount: 3, buckets } } };
    },
  });
});

test("confirmed Models billing returns to the canonical Models tab", async () => {
  await withDashboard(async ({ calls, replace }) => {
    expect(calls.some(({ path }) => path === "/v1/billing")).toBe(true);
    expect(replace).toHaveBeenCalledWith("/dashboard/ai-gateway?tab=openwork-models");
    expect(calls.some(({ path }) => path.includes("/stripe/checkout"))).toBe(false);
  }, {
    pathname: "/dashboard/billing/stripe/checking?return=models&session_id=mock-session",
    outsideGateway: true, page: <StripeCheckingPage />,
    reply: (path) => path === "/v1/billing" ? { payload: { billing: { stripe: { hasActiveSubscription: true } } } } : undefined,
  });
});
