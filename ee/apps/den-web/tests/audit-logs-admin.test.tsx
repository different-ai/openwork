import { expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { DenAdminPanel } from "../components/den-admin-panel";

type Reply = { payload: unknown; status?: number };
type Call = { path: string; init?: RequestInit };
type Fixture = {
  container: HTMLDivElement;
  calls: Call[];
  checkbox: (label: string) => HTMLInputElement;
  click: (label: string) => Promise<void>;
  flush: () => Promise<void>;
};

const page = { total: 1, limit: 50, offset: 0, returned: 1, hasMore: false, search: "", durationMs: 0 };
const otherCapabilities = { installLinks: true, mcpConnections: false, modelsAnalytics: true };
function organization(capabilities: unknown) {
  return { id: "org-a", name: "Test workspace", slug: "workspace", memberCount: 1, seatLimit: 5, plan: { tier: "free", source: "default" }, capabilities };
}

async function withAdmin(check: (fixture: Fixture) => Promise<void>, options: {
  capabilities?: unknown;
  source?: "overview" | "organizations";
  status?: number;
  put?: (call: Call) => Reply | Promise<Reply>;
} = {}) {
  GlobalRegistrator.register({ url: "https://den.example.test/admin" });
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  const calls: Call[] = [];
  const org = organization(options.capabilities);
  const request = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    const path = url.pathname.replace(/^\/api\/browser/, "");
    const call = { path, init };
    calls.push(call);
    let reply: Reply;
    if (path === "/v1/admin/overview") reply = {
      status: options.status,
      payload: { viewer: { id: "platform-admin", email: "admin@example.test" }, summary: { totalUsers: 0, totalOrganizations: 1 }, users: [], admins: [],
        organizations: options.source === "organizations" ? [] : [org], userPage: {},
        organizationPage: options.source === "organizations" ? { ...page, returned: 0 } : page },
    };
    else if (path === "/v1/admin/organizations") reply = { payload: { organizations: [org], page } };
    else if (path === "/v1/admin/organizations/org-a/capabilities" && init?.method === "PUT") reply = await (options.put?.(call) ?? { payload: { organization: org } });
    else throw new Error(`Unexpected request: ${init?.method} ${path}`);
    return new Response(JSON.stringify(reply.payload), { status: reply.status ?? 200 });
  });
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
  function checkbox(label: string) {
    const input = [...container.querySelectorAll("label")].find((entry) => entry.textContent?.trim() === label)?.querySelector("input");
    if (!input) throw new Error(`Missing checkbox: ${label}`);
    return input;
  }
  try {
    await act(async () => root.render(<DenAdminPanel />));
    await flush();
    if (!options.status || options.status === 200) {
      const organizations = [...container.querySelectorAll("button")].find((entry) => entry.textContent?.startsWith("Organizations ("));
      if (!organizations) throw new Error(`Missing organizations tab: ${container.textContent}`);
      await act(async () => organizations.click());
      await flush();
    }
    await check({ container, calls, checkbox, flush, click: async (label) => { await act(async () => checkbox(label).click()); await flush(); } });
  } finally {
    await act(async () => root.unmount());
    request.mockRestore();
    container.remove();
    await GlobalRegistrator.unregister();
    if (previousAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  }
}

for (const source of ["overview", "organizations"] satisfies ("overview" | "organizations")[]) {
  test.each([undefined, null, {}, { auditLogs: false }, { auditLogs: "true" }, { auditLogs: 1 }, { auditLogs: true }])(`${source} backend payload parses audit rollout with literal-true opt-in: %j`, async (capabilities) => {
    await withAdmin(async ({ checkbox, calls }) => {
      expect(checkbox("Audit logs").checked).toBe(capabilities?.auditLogs === true);
      expect(calls.some(({ path }) => path === `/v1/admin/${source}`)).toBe(true);
      expect(calls.every(({ init }) => init?.method === "GET")).toBe(true);
    }, { capabilities, source });
  });
}

test("platform admin audit checkbox sends a narrow capability update both ways and preserves other toggles", async () => {
  await withAdmin(async ({ checkbox, click, calls }) => {
    for (const enabled of [true, false]) {
      await click("Audit logs");
      expect(checkbox("Audit logs").checked).toBe(enabled);
      expect(checkbox("Install links").checked).toBe(true);
      expect(checkbox("OpenWork Connect (alpha)").checked).toBe(false);
      expect(checkbox("OpenWork Models task analytics (requires admin opt-in)").checked).toBe(true);
      const call = calls.at(-1);
      expect(call?.path).toBe("/v1/admin/organizations/org-a/capabilities");
      expect(call?.init?.method).toBe("PUT");
      expect(JSON.parse(String(call?.init?.body))).toEqual({ capabilities: { auditLogs: enabled } });
    }
    await click("Install links");
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({ capabilities: { installLinks: false } });
    await click("OpenWork Connect (alpha)");
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({ capabilities: { mcpConnections: true } });
    await click("OpenWork Models task analytics (requires admin opt-in)");
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({ capabilities: { modelsAnalytics: false } });
    expect(checkbox("Audit logs").checked).toBe(false);
  }, { capabilities: { ...otherCapabilities, auditLogs: false } });
});

test.each([false, true])("failed admin save rolls audit back from %s without changing other capabilities", async (initial) => {
  let finish: (reply: Reply) => void = () => { throw new Error("No pending save"); };
  const held = new Promise<Reply>((resolve) => { finish = resolve; });
  await withAdmin(async ({ container, checkbox, click, calls, flush }) => {
    await click("Audit logs");
    expect(checkbox("Audit logs").checked).toBe(!initial);
    for (const label of ["Audit logs", "Install links", "OpenWork Connect (alpha)", "OpenWork Models task analytics (requires admin opt-in)"]) expect(checkbox(label).disabled).toBe(true);
    await click("Install links");
    expect(calls.filter(({ init }) => init?.method === "PUT")).toHaveLength(1);
    await act(async () => finish({ status: 403, payload: { error: "forbidden" } }));
    await flush();
    expect(checkbox("Audit logs").checked).toBe(initial);
    expect(checkbox("Audit logs").disabled).toBe(false);
    expect(checkbox("Install links").checked).toBe(true);
    expect(checkbox("OpenWork Connect (alpha)").checked).toBe(false);
    expect(checkbox("OpenWork Models task analytics (requires admin opt-in)").checked).toBe(true);
    expect(container.querySelector('[data-testid="admin-capability-error"]')?.textContent).toContain("change was reverted");
  }, { capabilities: { ...otherCapabilities, auditLogs: initial }, put: () => held });
});

test("org admin without platform-admin access cannot self-enable audit from the admin panel", async () => {
  await withAdmin(async ({ container, calls }) => {
    expect(container.textContent).toContain("Admin access required");
    expect(container.querySelector('[data-testid="admin-capability-auditLogs"]')).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("GET");
  }, { status: 403 });
});
