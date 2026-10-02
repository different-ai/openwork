import { expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { DenAdminPanel } from "../components/den-admin-panel";

type Reply = { payload: unknown; status?: number };
type Call = { path: string; init?: RequestInit };
type Fixture = {
  container: HTMLDivElement;
  calls: Call[];
  toggle: () => HTMLButtonElement;
  click: () => Promise<void>;
  flush: () => Promise<void>;
};

const page = { total: 1, limit: 50, offset: 0, returned: 1, hasMore: false, search: "", durationMs: 0 };
function organization(capabilities: unknown) {
  return { id: "org-a", name: "Test workspace", slug: "workspace", memberCount: 1, seatLimit: 5, plan: { tier: "free", source: "default" }, capabilities };
}

async function withAdmin(check: (fixture: Fixture) => Promise<void>, options: {
  freeAuto?: unknown;
  capabilities?: unknown;
  source?: "overview" | "organizations";
  status?: number;
  save?: (call: Call) => Reply | Promise<Reply>;
} = {}) {
  GlobalRegistrator.register({ url: "https://den.example.test/admin" });
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  const calls: Call[] = [];
  const org = { ...organization(options.capabilities), freeAuto: options.freeAuto };
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
    else if (path === "/v1/admin/organizations/org-a/free-auto" && init?.method === "PATCH") reply = await (options.save?.(call) ?? { payload: { organization: org } });
    else throw new Error(`Unexpected request: ${init?.method} ${path}`);
    return new Response(JSON.stringify(reply.payload), { status: reply.status ?? 200 });
  });
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
  function toggle() {
    const button = container.querySelector<HTMLButtonElement>('[data-testid="admin-free-auto-workspace"]');
    if (!button) throw new Error("Missing free Auto toggle");
    return button;
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
    await check({ container, calls, toggle, flush, click: async () => { await act(async () => toggle().click()); await flush(); } });
  } finally {
    await act(async () => root.unmount());
    request.mockRestore();
    container.remove();
    await GlobalRegistrator.unregister();
    if (previousAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  }
}

test("free Auto is off for missing rollout data and saves both directions through the platform endpoint", async () => {
  await withAdmin(async ({ toggle, click, calls, container }) => {
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    for (const enabled of [true, false]) {
      await click();
      expect(toggle().getAttribute("aria-checked")).toBe(String(enabled));
      expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({ enabled });
      expect(calls.at(-1)?.init?.method).toBe("PATCH");
      expect(container.textContent).toContain(enabled ? "Enabled, deployment off" : "Disabled");
    }
  }, { save: (call) => ({ payload: { organization: { freeAuto: { enabled: JSON.parse(String(call.init?.body)).enabled, globallyEnabled: false, rolloutAllOrganizations: false } } } }) });
});

test("a failed free Auto save retains the confirmed state and gives the admin a retry", async () => {
  let finish: (reply: Reply) => void = () => { throw new Error("No pending save"); };
  const held = new Promise<Reply>((resolve) => { finish = resolve; });
  await withAdmin(async ({ toggle, click, calls, container, flush }) => {
    await click();
    expect(toggle().disabled).toBe(true);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await act(async () => finish({ status: 503, payload: { message: "Could not save. Try again." } }));
    await flush();
    expect(toggle().disabled).toBe(false);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Try again");
    expect(calls.filter((call) => call.init?.method === "PATCH")).toHaveLength(1);
  }, { save: () => held });
});
