import { afterAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OrganizationWebOrigin } from "@openwork/types/den/organization-web-origins";

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(() => GlobalRegistrator.unregister());
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const requests = await import("../app/(den)/_lib/den-flow");
const { parseOrgContextPayload } = await import("../app/(den)/_lib/den-org");
const { ORG_SCOPE_HEADER } = await import("../app/(den)/_lib/org-scope");
const organization = await import("../app/(den)/dashboard/_providers/org-dashboard-provider");
const { OrgWebOriginsSection } = await import("../app/(den)/dashboard/_components/org-web-origins-section");

const orgId = "org-fixture";
const path = "/v1/org/web-origins";
const existing: OrganizationWebOrigin = {
  id: "web-origin-one",
  origin: "https://workspace.example.com",
  createdAt: "2026-01-15T05:00:00.000Z",
  createdByName: "Example Owner",
};

type Call = { path: string; method: string; body: unknown; scope: string | null };
type Reply = { payload: unknown; status?: number };

const tick = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); };

async function mount(options: { canManage: boolean; origins?: OrganizationWebOrigin[]; failList?: boolean }) {
  const store = [...(options.origins ?? [])];
  let failList = options.failList ?? false;
  let nextId = 2;
  const calls: Call[] = [];
  const noop = async () => {};
  const org = spyOn(organization, "useOrgDashboard").mockReturnValue({
    orgSlug: "workspace", orgId, orgDirectory: [], activeOrg: null,
    orgContext: parseOrgContextPayload({
      organization: { id: orgId, name: "Workspace", slug: "workspace" },
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
  const request = spyOn(requests, "requestJson").mockImplementation(async (requestPath, init = {}) => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ path: requestPath, method, body, scope: new Headers(init.headers).get(ORG_SCOPE_HEADER) });
    let reply: Reply;
    if (requestPath === path && method === "GET") {
      reply = failList
        ? { status: 500, payload: { error: "internal_error", message: "Unexpected server error" } }
        : { payload: { origins: store, limit: 20 } };
    } else if (requestPath === path && method === "POST") {
      const created = { id: `web-origin-${nextId++}`, origin: body.origin, createdAt: "2026-02-01T05:00:00.000Z", createdByName: null };
      store.push(created);
      reply = { status: 201, payload: created };
    } else if (requestPath.startsWith(`${path}/`) && method === "DELETE") {
      const id = decodeURIComponent(requestPath.slice(path.length + 1));
      const index = store.findIndex((entry) => entry.id === id);
      if (index >= 0) store.splice(index, 1);
      return { payload: null, response: new Response(null, { status: 204 }), text: "" };
    } else {
      throw new Error(`Unexpected request ${method} ${requestPath}`);
    }
    return { payload: reply.payload, response: Response.json(reply.payload, { status: reply.status ?? 200 }), text: JSON.stringify(reply.payload) };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <OrgWebOriginsSection orgId={orgId} canManage={options.canManage} />
    </QueryClientProvider>,
  ));
  await tick();
  return {
    calls,
    container,
    setFailList(value: boolean) { failList = value; },
    writes: () => calls.filter((call) => call.method !== "GET"),
    async close() {
      await act(async () => root.unmount());
      client.clear();
      request.mockRestore();
      org.mockRestore();
      container.remove();
    },
  };
}

function summaryState(container: ParentNode) {
  return container.querySelector('[data-testid="web-origins-summary-state"]')?.textContent ?? "";
}

function findButton(container: ParentNode, label: string) {
  return [...container.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label) ?? null;
}

async function click(container: ParentNode, label: string) {
  const element = findButton(container, label);
  if (!element) throw new Error(`Missing button: ${label}`);
  await act(async () => element.click());
  await tick();
}

async function openSection(container: ParentNode) {
  const summary = container.querySelector("summary");
  if (!summary) throw new Error("Missing summary");
  await act(async () => summary.click());
  await tick();
}

async function typeOrigin(container: ParentNode, value: string) {
  const input = container.querySelector('input[type="url"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing origin input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await tick();
}

async function submit(container: ParentNode) {
  const form = container.querySelector("form");
  if (!form) throw new Error("Missing form");
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await tick();
}

function rows(container: ParentNode) {
  return [...container.querySelectorAll("[data-web-origin]")].map((row) => row.getAttribute("data-web-origin"));
}

test("collapsed summary shows the title and origin count", async () => {
  const view = await mount({ canManage: true, origins: [existing] });
  const details = view.container.querySelector("details");
  expect(details?.open).toBe(false);
  expect(view.container.querySelector("summary")?.textContent).toContain("Approved web origins");
  expect(summaryState(view.container)).toBe("1 origin");
  expect(view.calls[0]).toMatchObject({ path, method: "GET", scope: orgId });
  await view.close();
});

test("owner approves a normalized origin and the row appears", async () => {
  const view = await mount({ canManage: true, origins: [existing] });
  await openSection(view.container);
  expect(view.container.textContent).toContain("Members who sign in on an approved origin share their OpenWork session with that site.");
  await typeOrigin(view.container, "  https://Other.Example.com:8443/  ");
  await submit(view.container);
  expect(view.writes()).toEqual([{ path, method: "POST", body: { origin: "https://other.example.com:8443" }, scope: orgId }]);
  expect(rows(view.container)).toEqual([existing.origin, "https://other.example.com:8443"]);
  expect(summaryState(view.container)).toBe("2 origins");
  expect(view.container.textContent).toContain("Approved by Example Owner on");
  expect(view.container.textContent).toContain("Approved by a workspace owner on");
  await view.close();
});

test("invalid input shows guidance and sends nothing", async () => {
  const view = await mount({ canManage: true, origins: [] });
  await openSection(view.container);
  await typeOrigin(view.container, "https://workspace.example.com/app");
  await submit(view.container);
  expect(view.writes()).toEqual([]);
  const alert = view.container.querySelector('[role="alert"]');
  expect(alert?.textContent).toBe("Enter an exact HTTPS origin like https://workspace.example.com, with an optional port and no path.");
  await typeOrigin(view.container, "http://workspace.example.com");
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  await submit(view.container);
  expect(view.writes()).toEqual([]);
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("Enter an exact HTTPS origin");
  await view.close();
});

test("duplicate origins are blocked before sending", async () => {
  const view = await mount({ canManage: true, origins: [existing] });
  await openSection(view.container);
  await typeOrigin(view.container, "https://WORKSPACE.example.com/");
  await submit(view.container);
  expect(view.writes()).toEqual([]);
  expect(view.container.querySelector('[role="alert"]')?.textContent).toBe("This origin is already approved.");
  await view.close();
});

test("remove drops the row without a confirm and Undo re-approves it", async () => {
  const view = await mount({ canManage: true, origins: [existing] });
  await openSection(view.container);
  await click(view.container, `Remove ${existing.origin}`);
  expect(view.writes()).toEqual([{ path: `${path}/${existing.id}`, method: "DELETE", body: null, scope: orgId }]);
  expect(rows(view.container)).toEqual([]);
  expect(view.container.querySelector('[role="alertdialog"]')).toBeNull();
  expect(view.container.querySelector('[role="status"]')?.textContent).toContain(`Removed ${existing.origin}`);
  await click(view.container, "Undo");
  expect(view.writes().at(-1)).toEqual({ path, method: "POST", body: { origin: existing.origin }, scope: orgId });
  expect(rows(view.container)).toEqual([existing.origin]);
  expect(view.container.textContent).not.toContain("Removed ");
  await view.close();
});

test("admins see the list and its controls locked, with who can change them", async () => {
  const view = await mount({ canManage: false, origins: [existing] });
  await openSection(view.container);
  expect(rows(view.container)).toEqual([existing.origin]);
  expect(view.container.textContent).toContain("Locked. Owners and super-admins can change approved origins.");
  expect(view.container.textContent).not.toContain("share their OpenWork session");
  expect(view.container.querySelector<HTMLInputElement>('input[type="url"]')?.disabled).toBe(true);
  expect(findButton(view.container, `Remove ${existing.origin}`)?.disabled).toBe(true);
  expect(findButton(view.container, "Approve origin")?.disabled).toBe(true);
  expect(view.writes()).toEqual([]);
  await view.close();
});

test("empty state reports that nothing is approved", async () => {
  const view = await mount({ canManage: true, origins: [] });
  expect(summaryState(view.container)).toBe("None");
  await openSection(view.container);
  expect(view.container.textContent).toContain("No origins approved yet.");
  await view.close();
});

test("list failure offers Try again and recovers", async () => {
  const view = await mount({ canManage: true, failList: true });
  await openSection(view.container);
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load approved origins. Try again.");
  expect(view.container.querySelector("form")).toBeNull();
  view.setFailList(false);
  await click(view.container, "Try again");
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(summaryState(view.container)).toBe("None");
  await view.close();
});

test("at the limit the add control is disabled with direction", async () => {
  const full = Array.from({ length: 20 }, (_, index) => ({ ...existing, id: `web-origin-full-${index}`, origin: `https://w${index}.example.com` }));
  const view = await mount({ canManage: true, origins: full });
  await openSection(view.container);
  expect(view.container.textContent).toContain("Remove an origin to approve another. Up to 20.");
  expect(findButton(view.container, "Approve origin")?.disabled).toBe(true);
  await submit(view.container);
  expect(view.writes()).toEqual([]);
  await view.close();
});
