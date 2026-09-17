import { expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as navigation from "next/navigation";
import * as requests from "../app/(den)/_lib/den-flow";
import { parseOrgContextPayload } from "../app/(den)/_lib/den-org";
import * as organization from "../app/(den)/dashboard/_providers/org-dashboard-provider";
import { OrgDashboardDetailScreen } from "../app/(den)/dashboard/_components/org-dashboard-detail-screen";
import { orgDashboardsQueryKeys, useManagedDashboards, type ManagedDashboard } from "../app/(den)/dashboard/_components/org-dashboards-data";

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred result not initialized"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const initial: ManagedDashboard = {
  id: "dashboard-one", name: "Dashboard", createdByOrgMembershipId: "member-one",
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  elements: ["ALPHA", "BETA", "GAMMA"].map((project) => ({
    title: "Issue search", serverName: "issue-search", connectionId: "connection-one",
    toolName: "search", projectedToolName: "issue_search", resourceUri: "ui://issues/search",
    launchArguments: { jql: `project = ${project}`, maxResults: 20 },
    requiresApproval: true, organizationAutoLaunch: true,
  })),
};

type Reply = { payload: unknown; status?: number };

async function withDashboard(check: (fixture: {
  container: HTMLDivElement;
  client: QueryClient;
  button: (direction: "up" | "down", index: number) => HTMLButtonElement;
  order: () => string[];
  patch: ReturnType<typeof deferred<Reply>>;
  detail: ReturnType<typeof deferred<Reply>>;
  list: ReturnType<typeof deferred<Reply>>;
  calls: { path: string; method: string | undefined; body: unknown }[];
}) => Promise<void>) {
  GlobalRegistrator.register({ url: "https://app.example.test/dashboard" });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(orgDashboardsQueryKeys.detail("org-one", initial.id), initial);
  client.setQueryData(orgDashboardsQueryKeys.list("org-one"), [initial]);
  client.setQueryData(orgDashboardsQueryKeys.access("org-one", initial.id), []);
  const patch = deferred<Reply>();
  const detail = deferred<Reply>();
  const list = deferred<Reply>();
  const calls: { path: string; method: string | undefined; body: unknown }[] = [];
  const noop = async () => {};
  const org = spyOn(organization, "useOrgDashboard").mockReturnValue({
    orgSlug: "workspace", orgId: "org-one", orgDirectory: [], activeOrg: null,
    orgContext: parseOrgContextPayload({
      organization: { id: "org-one", name: "Workspace", slug: "workspace" },
      currentMember: { id: "member-one", userId: "user-one", role: "owner", isOwner: true },
    }),
    orgSelectionOpen: false, orgBusy: false, orgError: null, mutationBusy: null,
    reauthDialogOpen: false, orgSettingsCompletion: null,
    clearOrgSettingsCompletion: noop, refreshOrgData: noop, createOrganization: noop,
    updateOrganizationName: noop, updateOrganizationSettings: noop, deleteOrganization: noop,
    switchOrganization: noop, inviteMember: noop, startSeatCheckout: noop, cancelInvitation: noop,
    updateMemberRole: noop, removeMember: noop, transferOwnership: noop,
    createTeam: noop, updateTeam: noop, deleteTeam: noop, createRole: noop, updateRole: noop, deleteRole: noop,
    runReauthableAction: async (_label, action) => action(),
  });
  const router = spyOn(navigation, "useRouter").mockReturnValue({
    push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch: noop,
  });
  const request = spyOn(requests, "requestJson").mockImplementation(async (path, init) => {
    calls.push({ path, method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    const reply = await (init?.method === "PATCH" ? patch.promise
      : path === `/v1/dashboards/${initial.id}` ? detail.promise
      : path === "/v1/dashboards" ? list.promise
      : Promise.reject(new Error(`Unexpected request: ${init?.method} ${path}`)));
    return { response: Response.json(reply.payload, { status: reply.status ?? 200 }), payload: reply.payload, text: JSON.stringify(reply.payload) };
  });
  function Dashboard() {
    useManagedDashboards();
    return <OrgDashboardDetailScreen dashboardId={initial.id} />;
  }
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><Dashboard /></QueryClientProvider>));
    await check({
      container, client, patch, detail, list, calls,
      button: (direction, index) => {
        const button = container.querySelectorAll<HTMLButtonElement>(`button[aria-label="Move Issue search ${direction}"]`)[index];
        if (!button) throw new Error(`Missing move ${direction} button at ${index}`);
        return button;
      },
      order: () => [...container.querySelectorAll("p")].map((node) => node.textContent ?? "").filter((text) => text.startsWith("search · ")),
    });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    request.mockRestore();
    router.mockRestore();
    org.mockRestore();
    container.remove();
    await GlobalRegistrator.unregister();
  }
}

async function settle(check: () => void) {
  for (let attempt = 0; attempt < 50; attempt++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    try {
      check();
      return;
    } catch (error) {
      if (attempt === 49) throw error;
    }
  }
}

function rowText(dashboard: ManagedDashboard) {
  return dashboard.elements.map((element) => `${element.toolName} · ${JSON.stringify(element.launchArguments)} · runs automatically by organization policy`);
}

test("move controls name their action, respect bounds, and wait for PATCH and refreshed ordering before a second move", async () => {
  await withDashboard(async ({ button, order, patch, detail, list, calls, client }) => {
    const patches = () => calls.filter((call) => call.method === "PATCH");
    const buttonsDisabled = () => {
      for (let index = 0; index < 3; index++) {
        expect(button("up", index).disabled).toBe(true);
        expect(button("down", index).disabled).toBe(true);
      }
    };
    expect(order()).toEqual(rowText(initial));
    expect(button("up", 0).disabled).toBe(true);
    expect(button("down", 2).disabled).toBe(true);
    expect(button("up", 1).title).toBe("Move Issue search up");
    expect(button("down", 0).title).toBe("Move Issue search down");
    expect(button("down", 0).getAttribute("data-slot")).toBe("tooltip-trigger");
    await act(async () => { button("up", 0).click(); button("down", 2).click(); });
    expect(patches()).toEqual([]);

    const originalFirstButton = button("down", 0);
    await act(async () => originalFirstButton.click());
    await settle(buttonsDisabled);
    const afterDown = { ...initial, elements: [initial.elements[1], initial.elements[0], initial.elements[2]] };
    expect(patches()).toEqual([{ path: `/v1/dashboards/${initial.id}`, method: "PATCH", body: { elements: afterDown.elements } }]);
    await act(async () => button("up", 1).click());
    expect(patches()).toHaveLength(1);

    await act(async () => patch.resolve({ payload: { item: afterDown } }));
    await settle(() => {
      expect(calls.filter((call) => call.method === "GET").map((call) => call.path).sort()).toEqual(["/v1/dashboards", `/v1/dashboards/${initial.id}`]);
      buttonsDisabled();
    });
    expect(order()).toEqual(rowText(initial));
    await act(async () => button("down", 0).click());
    expect(patches()).toHaveLength(1);

    await act(async () => detail.resolve({ payload: { item: afterDown } }));
    await settle(() => { expect(order()).toEqual(rowText(afterDown)); buttonsDisabled(); });
    await act(async () => list.resolve({ payload: { items: [afterDown] } }));
    await settle(() => expect(button("up", 1).disabled).toBe(false));
    expect(button("down", 1)).toBe(originalFirstButton);
    expect(client.getQueryData(orgDashboardsQueryKeys.list("org-one"))).toEqual([afterDown]);

    await act(async () => button("up", 2).click());
    await settle(() => expect(patches()).toHaveLength(2));
    expect(patches()[1]).toEqual({
      path: `/v1/dashboards/${initial.id}`, method: "PATCH",
      body: { elements: [initial.elements[1], initial.elements[2], initial.elements[0]] },
    });
    expect(initial.elements.map((element) => element.launchArguments?.jql)).toEqual(["project = ALPHA", "project = BETA", "project = GAMMA"]);
  });
});

test("a failed move leaves the saved order intact and restores the controls", async () => {
  await withDashboard(async ({ button, order, patch, calls, container }) => {
    await act(async () => button("up", 1).click());
    await settle(() => expect(button("up", 1).disabled).toBe(true));
    await act(async () => patch.resolve({ status: 500, payload: { message: "Could not save order" } }));
    await settle(() => {
      expect(button("up", 1).disabled).toBe(false);
      expect(container.textContent).toContain("Could not save order");
    });
    expect(order()).toEqual(rowText(initial));
    expect(button("up", 0).disabled).toBe(true);
    expect(button("down", 2).disabled).toBe(true);
    expect(calls).toEqual([{
      path: `/v1/dashboards/${initial.id}`, method: "PATCH",
      body: { elements: [initial.elements[1], initial.elements[0], initial.elements[2]] },
    }]);
  });
});
