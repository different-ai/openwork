import { expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as requests from "../app/(den)/_lib/den-flow";
import * as dashboard from "../app/(den)/dashboard/_providers/org-dashboard-provider";
import { AuditLogsScreen, getAuditAccess } from "../app/(den)/dashboard/_components/audit-logs-screen";
import { AuditChanges, AuditOutcome, AuditUsageFacts } from "../app/(den)/dashboard/_components/audit-logs-details";
import { auditDashboard, auditEvent, auditEventTypes, auditOperation, auditPolicy, auditUsage, eventsPage, operationsPage } from "./audit-logs-fixtures";

type Reply = { payload: unknown; status?: number };
type Fixture = {
  container: HTMLDivElement;
  client: QueryClient;
  unmount: () => Promise<void>;
  calls: { path: string; init?: RequestInit }[];
  click: (label: string) => Promise<void>;
  select: (label: string, option: string) => Promise<void>;
  toggle: (label: string) => Promise<void>;
  type: (label: string, value: string) => Promise<void>;
  rerender: (state: ReturnType<typeof dashboard.useOrgDashboard>) => Promise<void>;
  flush: () => Promise<void>;
};

async function withScreen(check: (fixture: Fixture) => Promise<void>, options: {
  state?: ReturnType<typeof dashboard.useOrgDashboard>;
  reply?: (path: string, init?: RequestInit) => Reply | Promise<Reply>;
  eventTypesReply?: (init?: RequestInit) => Reply | Promise<Reply>;
} = {}) {
  GlobalRegistrator.register({ url: "https://den.example.test/dashboard/audit-logs" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const container = document.createElement("div");
  document.body.append(container);
  // React must discover a DOM before loading its input/change-event support.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  let mounted = true;
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false; } };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  let state = options.state ?? auditDashboard();
  const context = spyOn(dashboard, "useOrgDashboard").mockImplementation(() => state);
  const calls: Fixture["calls"] = [];
  const request = spyOn(requests, "requestJson").mockImplementation(async (path, init) => {
    calls.push({ path, init });
    const result = path === "/v1/audit/event-types"
      ? await (options.eventTypesReply?.(init) ?? { payload: auditEventTypes })
      : await (options.reply?.(path, init) ?? { payload: path.includes("/events") ? eventsPage() : path.includes("/usage") ? auditUsage : operationsPage() });
    return { response: new Response(null, { status: result.status ?? 200 }), payload: result.payload, text: "" };
  });
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
  const render = async () => { await act(async () => { root.render(<QueryClientProvider client={client}><AuditLogsScreen /></QueryClientProvider>); }); await flush(); };
  async function click(label: string) {
    const button = [...container.querySelectorAll("button")].find((entry) => entry.getAttribute("aria-label") === label || entry.textContent === label);
    if (!button) throw new Error(`Missing button: ${label}`);
    await act(async () => button.click());
    await flush();
  }
  async function select(label: string, option: string) {
    await click(label);
    const button = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((entry) => entry.textContent === option);
    if (!button) throw new Error(`Missing option: ${option}`);
    await act(async () => button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await flush();
  }
  async function type(label: string, value: string) {
    const input = [...container.querySelectorAll("input")].find((entry) => entry.getAttribute("aria-label") === label);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!input || !setter) throw new Error(`Missing input: ${label}`);
    await act(async () => {
      input.focus();
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
  }
  async function toggle(label: string) {
    const summary = [...container.querySelectorAll("summary")].find((entry) => entry.textContent === label);
    const details = summary?.parentElement;
    if (!(details instanceof HTMLDetailsElement)) throw new Error(`Missing disclosure: ${label}`);
    await act(async () => { details.open = !details.open; details.dispatchEvent(new Event("toggle")); });
    await flush();
  }
  try {
    await render();
    await check({ container, client, unmount, calls, click, select, toggle, type, flush, rerender: async (next) => { state = next; await render(); } });
  } finally {
    await unmount();
    client.clear(); context.mockRestore(); request.mockRestore(); container.remove();
    await GlobalRegistrator.unregister();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  }
}

test.each(["member", "custom-role"])("%s gets a locked state without fetching or redirecting", async (role) => {
  await withScreen(async ({ container, calls }) => {
    expect(container.querySelector('[data-testid="audit-locked"]')).not.toBeNull();
    expect(container.textContent).toContain("organization owner");
    expect(container.textContent).not.toContain("Redirecting");
    expect(calls).toHaveLength(0);
  }, { state: auditDashboard("org-a", role) });
});

test("pending, mismatched and switching contexts do not mount audit queries", async () => {
  await withScreen(async ({ container, calls, rerender }) => {
    expect(container.querySelector('[data-testid="audit-skeleton"]')).not.toBeNull();
    expect(calls).toHaveLength(0);
    await rerender({ ...auditDashboard(), orgId: "org-b" });
    expect(calls).toHaveLength(0);
    await rerender({ ...auditDashboard(), mutationBusy: "switch-organization" });
    expect(calls).toHaveLength(0);
    await rerender(auditDashboard());
    expect(calls).toHaveLength(2);
  }, { state: { ...auditDashboard(), orgBusy: true } });
});

test("org errors are retryable rather than loading forever or showing restricted data", async () => {
  await withScreen(async ({ container, calls }) => {
    expect(container.textContent).toContain("Retry access check");
    expect(container.querySelector('[data-testid="audit-skeleton"]')).toBeNull();
    expect(calls).toHaveLength(0);
  }, { state: { ...auditDashboard(), orgError: "upstream error" } });
});

test("one operation expands into multiple events with distinct outcomes and readable changes", async () => {
  await withScreen(async ({ container, calls, click }) => {
    expect(container.querySelectorAll("tbody > tr")).toHaveLength(1);
    expect(container.textContent).toContain("Partially completed");
    expect(container.textContent).toContain("Test owner");
    expect(container.textContent).toContain("Team models");
    expect(calls).toHaveLength(2);
    await click("View changes for Provider updated");
    expect(container.querySelectorAll('[data-testid="audit-event"]')).toHaveLength(3);
    expect(container.textContent).toContain("Old models");
    expect(container.textContent).toContain("Before");
    expect(container.textContent).toContain("After");
    expect(container.textContent).toContain("Unknown");
    expect(container.textContent).toContain("Denied");
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector('[aria-expanded="true"][aria-controls="audit-operation-operation-a"]')).not.toBeNull();
    await click("Hide changes for Provider updated");
    expect(container.querySelectorAll('[data-testid="audit-event"]')).toHaveLength(0);
  }, { reply: (path) => ({ payload: path.includes("/events") ? eventsPage([auditEvent, { ...auditEvent, id: "event-b", sequence: 2, action: "credentials.updated", outcome: "denied" }, { ...auditEvent, id: "event-c", sequence: 3, action: "access.updated", outcome: "unknown" }]) : operationsPage() }) });
});

test("operation and event cursors load additional rows without replacing earlier rows", async () => {
  await withScreen(async ({ container, calls, click }) => {
    await click("Load more operations");
    expect(container.querySelectorAll("tbody > tr")).toHaveLength(2);
    await click("View changes for Provider updated");
    await click("Load more events");
    expect(container.querySelectorAll('[data-testid="audit-event"]')).toHaveLength(2);
    expect(calls.some(({ path }) => path.includes("cursor=operations-next"))).toBe(true);
    expect(calls.some(({ path }) => path.includes("cursor=events-next"))).toBe(true);
    for (const call of calls) expect(new Headers(call.init?.headers).get("x-openwork-org-id")).toBe("org-a");
  }, { reply: (path) => ({ payload: path.includes("/events")
    ? path.includes("cursor=") ? eventsPage([{ ...auditEvent, id: "event-b", sequence: 2 }]) : eventsPage([auditEvent], "events-next")
    : path.includes("cursor=") ? operationsPage([{ ...auditOperation, id: "operation-b", action: "member.removed" }]) : operationsPage([auditOperation], "operations-next") }) });
});

test("filters start at the first page, distinguish no matches, and reset their controls", async () => {
  await withScreen(async ({ container, calls, click, select, toggle }) => {
    await toggle("More filters");
    await select("Result", "Unknown");
    await click("Apply filters");
    expect(calls.at(-1)?.path).toContain("outcome=unknown");
    expect(calls.at(-1)?.path).not.toContain("cursor=");
    expect(container.textContent).toContain("No operations match these filters");
    await click("Show all operations");
    expect(container.querySelector('button[aria-label="Result"]')?.textContent).toContain("All results");
    expect(container.textContent).toContain("Team models");
  }, { reply: (path) => ({ payload: operationsPage(path.includes("outcome=unknown") ? [] : [auditOperation]) }) });
});

test("timeframe, complete event types and unified ID search are primary filters even with empty history", async () => {
  await withScreen(async ({ container, click, select, calls }) => {
    const primary = container.querySelector('[data-testid="audit-primary-filters"]');
    expect(primary).not.toBeNull();
    for (const label of ["From (local time)", "To (local time)", "Event type", "Search IDs"]) {
      expect(primary?.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
      expect(primary?.querySelector(`[aria-label="${label}"]`)?.closest("details")).toBeNull();
    }
    await select("Event type", "Provider credential updated");
    await click("Apply filters");
    expect(calls.at(-1)?.path).toContain("action=provider.credential.updated");
    expect(container.querySelector('button[aria-label="Event type"]')?.textContent).toContain("Provider credential updated");
    expect(container.textContent).toContain("No operations match");
    expect(calls.filter(({ path }) => path === "/v1/audit/event-types")).toHaveLength(1);
    await click("Clear filters");
    expect(container.querySelector('button[aria-label="Event type"]')?.textContent).toContain("All event types");
    await click("Event type");
    expect(container.querySelector('[role="listbox"]')?.textContent).toContain("Provider credential updated");
  }, { reply: () => ({ payload: operationsPage([]) }) });
});

test("applied dates become UTC and IDs are trimmed without losing exact characters", async () => {
  await withScreen(async ({ calls, type, click, container }) => {
    await type("From (local time)", "2026-09-01T09:15");
    await type("To (local time)", "2026-09-25T18:30");
    await type("Search IDs", "  request/+? & A  ");
    await click("Apply filters");
    const params = new URL(calls.at(-1)?.path ?? "", "https://den.example.test").searchParams;
    expect(params.get("from")).toBe(new Date("2026-09-01T09:15").toISOString());
    expect(params.get("to")).toBe(new Date("2026-09-25T18:30").toISOString());
    expect(params.get("searchId")).toBe("request/+? & A");
    expect(params.has("resourceId")).toBe(false);
    await click("Clear filters");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Search IDs"]')?.value).toBe("");
    expect(container.querySelector<HTMLInputElement>('[aria-label="From (local time)"]')?.value).toBe("");
  });
});

test("invalid date ranges do not issue requests or discard draft IDs", async () => {
  await withScreen(async ({ container, calls, type, click }) => {
    await type("From (local time)", "2026-09-25T18:30");
    await type("To (local time)", "2026-09-01T09:15");
    await type("Search IDs", "event-a");
    const count = calls.length;
    await click("Apply filters");
    expect(calls).toHaveLength(count);
    expect(container.textContent).toContain("Choose a valid date range");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Search IDs"]')?.value).toBe("event-a");
  });
});

test("catalog failures keep history and can retry independently", async () => {
  let unavailable = true;
  await withScreen(async ({ container, calls, click, select }) => {
    expect(container.textContent).toContain("Team models");
    expect(container.textContent).toContain("Could not load event types");
    unavailable = false;
    await click("Retry event types");
    expect(calls.filter(({ path }) => path.startsWith("/v1/audit/operations"))).toHaveLength(1);
    await select("Event type", "Provider credential updated");
    await click("Apply filters");
    unavailable = true;
    await click("Refresh history");
    expect(container.textContent).toContain("last verified catalog");
    expect(container.querySelector('button[aria-label="Event type"]')?.textContent).toContain("Provider credential updated");
    expect(container.textContent).toContain("Team models");
  }, { eventTypesReply: () => unavailable ? { status: 503, payload: {} } : { payload: auditEventTypes } });
});

test("catalog permission loss hides cached history, not just the dropdown", async () => {
  let denied = false;
  await withScreen(async ({ container, click }) => {
    expect(container.textContent).toContain("Team models");
    denied = true;
    await click("Refresh history");
    expect(container.textContent).not.toContain("Team models");
    expect(container.querySelector('[data-testid="audit-locked"]')).not.toBeNull();
    denied = false;
    await click("Retry access check");
    expect(container.textContent).toContain("Team models");
  }, { eventTypesReply: () => denied ? { status: 403, payload: { error: "forbidden" } } : { payload: auditEventTypes } });
});

test("zero history gives capture direction without inventing retention guarantees", async () => {
  await withScreen(async ({ container }) => {
    expect(container.textContent).toContain("No retained audit operations yet");
    expect(container.textContent).toContain("Review capture and storage");
  }, { reply: () => ({ payload: operationsPage([]) }) });
});

test("refresh failures retain verified rows; permission loss clears them", async () => {
  let status = 200;
  await withScreen(async ({ container, click }) => {
    status = 503;
    await click("Refresh history");
    expect(container.textContent).toContain("Team models");
    expect(container.textContent).toContain("last verified results");
    expect(container.querySelector('[data-testid="audit-skeleton"]')).toBeNull();
    status = 403;
    await click("Retry");
    expect(container.textContent).not.toContain("Team models");
    expect(container.textContent).toContain("visibility is disabled");
    status = 200;
    await click("Retry access check");
    expect(container.textContent).toContain("Team models");
  }, { reply: () => ({ status, payload: status === 200 ? operationsPage() : { error: "audit_visibility_disabled" } }) });
});

test("removed membership clears previously loaded history on refresh", async () => {
  let removed = false;
  await withScreen(async ({ container, click }) => {
    expect(container.textContent).toContain("Team models");
    removed = true;
    await click("Refresh history");
    expect(container.textContent).not.toContain("Team models");
    expect(container.querySelector('[data-testid="audit-locked"]')).not.toBeNull();
  }, { reply: () => removed ? { status: 404, payload: { error: "organization_not_found" } } : { payload: operationsPage() } });
});

test("timeline permission loss locks the entire history, including cached rows", async () => {
  await withScreen(async ({ container, click }) => {
    await click("View changes for Provider updated");
    expect(container.textContent).toContain("Audit visibility is disabled");
    expect(container.textContent).not.toContain("Team models");
  }, { reply: (path) => path.includes("/events") ? { status: 403, payload: { error: "audit_visibility_disabled" } } : { payload: operationsPage() } });
});

test("usage is lazy, capacity is read-only, and actual capture is separate from launch policies", async () => {
  await withScreen(async ({ container, calls, toggle }) => {
    expect(calls.some(({ path }) => path.includes("usage"))).toBe(false);
    await toggle("Capture and storage");
    expect(calls.some(({ path }) => path.includes("usage"))).toBe(true);
    for (const text of ["many requests", "not a guaranteed number of days", "not disk usage", "Instance operator", "Dry run only", "Not configured", "Read-only capacity policy", "Billing is disabled"]) expect(container.textContent).toContain(text);
    expect(container.textContent).not.toContain("Buy");
    expect(container.textContent).not.toContain("Save changes");
  });
});

test("organization changes abort pending reads and cannot reveal their late data", async () => {
  let finish: (reply: Reply) => void = () => { throw new Error("No held request"); };
  const held = new Promise<Reply>((resolve) => { finish = resolve; });
  await withScreen(async ({ container, calls, rerender, flush }) => {
    const signal = calls[0].init?.signal;
    expect(container.querySelector('[data-testid="audit-skeleton"]')).not.toBeNull();
    await rerender(auditDashboard("org-b"));
    expect(signal?.aborted).toBe(true);
    expect(container.textContent).toContain("Second workspace");
    await act(async () => finish({ payload: operationsPage() }));
    await flush();
    expect(container.textContent).not.toContain("Team models");
    await rerender({ ...auditDashboard("org-b"), orgContext: null, orgId: null });
    expect(container.textContent).not.toContain("Second workspace");
  }, { reply: (_path, init) => new Headers(init?.headers).get("x-openwork-org-id") === "org-a" ? held : { payload: operationsPage([{ ...auditOperation, resources: [{ type: "provider", id: "provider-b", relationship: "target", label: "Second workspace" }] }]) } });
});

test("initial request errors are retryable and never become an empty-history claim", async () => {
  let failing = true;
  await withScreen(async ({ container, calls, click }) => {
    expect(container.textContent).toContain("Could not load audit history");
    expect(container.querySelector('[data-testid="audit-empty"]')).toBeNull();
    expect(calls).toHaveLength(2);
    failing = false;
    await click("Retry");
    expect(container.textContent).toContain("Team models");
  }, { reply: () => failing ? { status: 500, payload: { error: "internal_error" } } : { payload: operationsPage() } });
});

test("a failed later page retains earlier operations and retries only its cursor", async () => {
  let failing = true;
  await withScreen(async ({ container, calls, click }) => {
    await click("Load more operations");
    expect(container.textContent).toContain("Team models");
    expect(container.textContent).toContain("last verified results");
    failing = false;
    await click("Retry");
    expect(calls.at(-1)?.path).toContain("cursor=next");
    expect(container.querySelectorAll("tbody > tr")).toHaveLength(2);
  }, { reply: (path) => path.includes("cursor=") ? failing ? { status: 503, payload: {} } : { payload: operationsPage([{ ...auditOperation, id: "operation-b" }]) } : { payload: operationsPage([auditOperation], "next") } });
});

test("usage permission loss clears the operation list", async () => {
  await withScreen(async ({ container, toggle }) => {
    await toggle("Capture and storage");
    expect(container.textContent).toContain("visibility is disabled");
    expect(container.textContent).not.toContain("Team models");
  }, { reply: (path) => path.includes("usage") ? { status: 403, payload: { error: "audit_visibility_disabled" } } : { payload: operationsPage() } });
});

test("role downgrade unmounts expanded events and discards retained history", async () => {
  await withScreen(async ({ container, click, calls, rerender }) => {
    await click("View changes for Provider updated");
    expect(container.querySelector('[data-testid="audit-event"]')).not.toBeNull();
    const count = calls.length;
    await rerender(auditDashboard("org-a", "member"));
    expect(container.textContent).not.toContain("Team models");
    expect(container.querySelector('[data-testid="audit-locked"]')).not.toBeNull();
    expect(calls).toHaveLength(count);
  });
});

function captureUsage(captureOn: boolean, overrides: Partial<typeof auditUsage> = {}): typeof auditUsage {
  if (!auditUsage.policy) throw new Error("Missing policy fixture");
  const usage: typeof auditUsage = { ...auditUsage, ...overrides, captureOn, policy: { ...auditUsage.policy, ...overrides.policy, enabled: captureOn } };
  if (overrides.policy === null) usage.policy = null;
  return { ...usage, captureEnabled: Boolean(usage.policy && captureOn && usage.entitlement.enabled && usage.captureAvailable) };
}

function captureSwitch(container: HTMLElement) {
  const control = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Capture audit logs"]');
  if (!control) throw new Error("Missing capture switch");
  return control;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Uninitialized promise"); };
  let reject: (error: Error) => void = () => { throw new Error("Uninitialized promise"); };
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const captureMatrix = [
  { enabled: true, source: "enterprise_plan", label: "Included in Enterprise" },
  { enabled: true, source: "self_hosted", label: "Enabled by instance operator" },
  { enabled: false, source: "none", label: "Requires Enterprise" },
] satisfies (typeof auditUsage.entitlement & { label: string })[];
for (const { label, ...entitlement } of captureMatrix) {
  for (const captureOn of [false, true]) {
    test.each([false, true])(`${label}; org capture ${captureOn}; rollout %s`, async (captureAvailable) => {
      const usage = captureUsage(captureOn, { entitlement, captureAvailable });
      await withScreen(async ({ container, toggle, click, calls }) => {
        await toggle("Capture and storage");
        expect(container.textContent).toContain(label);
        expect(container.textContent).toContain(usage.captureEnabled ? "Recording" : "Not recording");
        expect(captureSwitch(container).getAttribute("aria-checked")).toBe(String(captureOn));
        expect(captureSwitch(container).disabled).toBe(!captureOn && (!entitlement.enabled || !captureAvailable));
        expect(container.textContent).toContain("Team models");
        if (!usage.captureEnabled) expect(container.textContent).toContain("New activity is not recorded. Retained history remains available.");
        if (captureSwitch(container).disabled) {
          await click("Capture audit logs");
          expect(calls.some(({ init }) => init?.method === "PATCH")).toBe(false);
          expect(container.querySelector('#audit-capture-status')?.textContent).toContain(entitlement.enabled ? "instance operator" : "organization owner");
        }
      }, { reply: (path) => ({ payload: path.includes("usage") ? usage : operationsPage() }) });
    });
  }
}

test("missing storage policy is an operator lock, not a plan denial", async () => {
  await withScreen(async ({ container, toggle, click, calls }) => {
    await toggle("Capture and storage");
    expect(captureSwitch(container).disabled).toBe(true);
    expect(container.textContent).toContain("Ask an instance admin to configure audit storage.");
    expect(container.textContent).not.toContain("Requires Enterprise");
    await click("Capture audit logs");
    expect(calls.some(({ init }) => init?.method === "PATCH")).toBe(false);
  }, { reply: (path) => ({ payload: path.includes("usage") ? captureUsage(false, { policy: null }) : operationsPage() }) });
});

test("verified on/off changes preserve loaded history, expanded changes and action/ID filters", async () => {
  let usage = captureUsage(false);
  await withScreen(async ({ container, toggle, select, type, click, calls }) => {
    await select("Event type", "Provider credential updated");
    await type("Search IDs", "request-a");
    await click("Apply filters");
    await click("View changes for Provider updated");
    await toggle("Capture and storage");
    const reads = calls.filter(({ path }) => path.includes("operations")).length;
    for (const captureOn of [true, false]) {
      await click("Capture audit logs");
      expect(captureSwitch(container).getAttribute("aria-checked")).toBe(String(captureOn));
      expect(container.textContent).toContain("Team models");
      expect(container.querySelector('[data-testid="audit-event"]')).not.toBeNull();
      expect(container.querySelector<HTMLInputElement>('[aria-label="Search IDs"]')?.value).toBe("request-a");
      expect(container.querySelector('[aria-label="Event type"]')?.textContent).toContain("Provider credential updated");
    }
    expect(calls.filter(({ path }) => path.includes("operations"))).toHaveLength(reads);
    expect(calls.filter(({ init }) => init?.method === "PATCH").map(({ init }) => JSON.parse(String(init?.body))))
      .toEqual([{ captureOn: true, expectedRevision: 1 }, { captureOn: false, expectedRevision: 2 }]);
  }, { reply: (path, init) => {
    if (path.includes("settings")) {
      const body = JSON.parse(String(init?.body));
      usage = captureUsage(body.captureOn, { policy: { ...auditPolicy, revision: (usage.policy?.revision ?? 0) + 1 } });
      return { payload: usage };
    }
    return { payload: path.includes("usage") ? usage : path.includes("events") ? eventsPage() : operationsPage() };
  } });
});

test.each([false, true])("OFF is allowed after entitlement loss with rollout %s", async (captureAvailable) => {
  await withScreen(async ({ container, toggle, click, calls }) => {
    await toggle("Capture and storage");
    expect(captureSwitch(container).disabled).toBe(false);
    await click("Capture audit logs");
    expect(captureSwitch(container).getAttribute("aria-checked")).toBe("false");
    expect(captureSwitch(container).disabled).toBe(true);
    expect(container.textContent).toContain("Team models");
    expect(calls.filter(({ init }) => init?.method === "PATCH")).toHaveLength(1);
  }, { reply: (path, init) => ({ payload: path.includes("usage") || path.includes("settings")
    ? captureUsage(init?.method !== "PATCH", { entitlement: { enabled: false, source: "none" }, captureAvailable }) : operationsPage() }) });
});

test("in-flight capture stays on last verified state and cannot be double submitted", async () => {
  const held = deferred<Reply>();
  await withScreen(async ({ container, toggle, click, calls, flush }) => {
    await toggle("Capture and storage");
    await click("Capture audit logs");
    expect(captureSwitch(container).getAttribute("aria-checked")).toBe("true");
    expect(captureSwitch(container).disabled).toBe(true);
    await click("Capture audit logs");
    expect(calls.filter(({ init }) => init?.method === "PATCH")).toHaveLength(1);
    await act(async () => held.resolve({ payload: captureUsage(false) }));
    await flush();
    expect(captureSwitch(container).getAttribute("aria-checked")).toBe("false");
    expect(captureSwitch(container).disabled).toBe(false);
  }, { reply: (path, init) => init?.method === "PATCH" ? held.promise : { payload: path.includes("usage") ? auditUsage : operationsPage() } });
});

test.each(["network", "timeout", "server", "malformed", "wrong-org", "unknown-denial"])("%s capture outcome never replays and requires explicit status refresh", async (kind) => {
  let usageReads = 0;
  await withScreen(async ({ container, toggle, click, calls, flush }) => {
    await toggle("Capture and storage");
    await click("Capture audit logs");
    await flush();
    expect(captureSwitch(container).getAttribute("aria-checked")).toBe("true");
    expect(captureSwitch(container).disabled).toBe(true);
    expect(container.textContent).toContain("capture change could not be verified");
    expect(container.textContent).not.toContain("private-server-detail");
    expect(container.textContent).not.toContain("requires Enterprise");
    expect(container.textContent).toContain("Team models");
    expect(usageReads).toBe(1);
    await toggle("Capture and storage");
    await toggle("Capture and storage");
    expect(captureSwitch(container).disabled).toBe(true);
    await click("Capture audit logs");
    expect(calls.filter(({ init }) => init?.method === "PATCH")).toHaveLength(1);
    await click("Refresh status");
    expect(usageReads).toBe(2);
    expect(captureSwitch(container).getAttribute("aria-checked")).toBe("false");
    expect(captureSwitch(container).disabled).toBe(false);
    expect(calls.filter(({ init }) => init?.method === "PATCH")).toHaveLength(1);
  }, { reply: (path, init) => {
    if (init?.method === "PATCH") {
      if (kind === "network") throw new TypeError("private-server-detail");
      if (kind === "timeout") throw new requests.DenRequestTimeoutError(15000);
      if (kind === "server" || kind === "unknown-denial") return { status: kind === "server" ? 503 : 400, payload: { error: "private-server-detail" } };
      return { payload: kind === "malformed" ? { ok: true } : captureUsage(false, { policy: { ...auditPolicy, organizationId: "org-b" } }) };
    }
    if (path.includes("usage")) return { payload: captureUsage(++usageReads === 1) };
    return { payload: operationsPage() };
  } });
});

test("an unverified enable result labels last-known Off without claiming recording is still stopped", async () => {
  await withScreen(async ({ container, toggle, click }) => {
    await toggle("Capture and storage");
    expect(container.textContent).toContain("New activity is not recorded.");
    await click("Capture audit logs");
    expect(captureSwitch(container).getAttribute("aria-checked")).toBe("false");
    expect(captureSwitch(container).disabled).toBe(true);
    expect(container.textContent).toContain("Showing the last verified state from");
    expect(container.textContent).not.toContain("New activity is not recorded.");
  }, { reply: (path, init) => init?.method === "PATCH" ? { status: 503, payload: {} }
    : { payload: path.includes("usage") ? captureUsage(false) : operationsPage() } });
});

test.each(["audit_policy_changed", "audit_policy_not_configured", "audit_capture_unavailable", "enterprise_plan_required"])("%s refreshes status without resubmitting capture", async (code) => {
  let usageReads = 0;
  const latest = captureUsage(false, code === "enterprise_plan_required" ? { entitlement: { enabled: false, source: "none" } }
    : code === "audit_policy_not_configured" ? { policy: null } : code === "audit_capture_unavailable" ? { captureAvailable: false }
      : { policy: { ...auditPolicy, revision: 8 } });
  await withScreen(async ({ container, toggle, click, calls }) => {
    await toggle("Capture and storage");
    await click("Capture audit logs");
    expect(usageReads).toBe(2);
    expect(container.textContent).toContain(code === "audit_policy_changed" ? "Review the latest status and try again" : "Review the latest restrictions");
    expect(container.textContent).toContain("Team models");
    expect(captureSwitch(container).disabled).toBe(code !== "audit_policy_changed");
    expect(calls.filter(({ init }) => init?.method === "PATCH")).toHaveLength(1);
    if (code === "audit_policy_changed") {
      await click("Capture audit logs");
      const patches = calls.filter(({ init }) => init?.method === "PATCH");
      expect(JSON.parse(String(patches[1].init?.body))).toEqual({ captureOn: true, expectedRevision: 8 });
    }
  }, { reply: (path, init) => init?.method === "PATCH" ? { status: code === "enterprise_plan_required" ? 402 : 409, payload: { error: code } }
    : { payload: path.includes("usage") ? ++usageReads === 1 ? captureUsage(false) : latest : operationsPage() } });
});

test.each([401, 403, 404])("capture mutation %s locks all cached history", async (status) => {
  await withScreen(async ({ container, toggle, click }) => {
    await toggle("Capture and storage");
    await click("Capture audit logs");
    expect(container.querySelector('[data-testid="audit-locked"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Team models");
    expect(container.querySelector('[role="switch"]')).toBeNull();
  }, { reply: (path, init) => init?.method === "PATCH" ? { status, payload: { error: status === 404 ? "organization_not_found" : "forbidden" } }
    : { payload: path.includes("usage") ? auditUsage : operationsPage() } });
});

test.each(["loading", "read-error", "malformed"])("capture %s is safely disabled without hiding history", async (kind) => {
  const held = deferred<Reply>();
  await withScreen(async ({ container, toggle, click, calls }) => {
    await toggle("Capture and storage");
    expect(captureSwitch(container).disabled).toBe(true);
    expect(container.textContent).toContain("Not verified");
    expect(container.textContent).toContain("Team models");
    await click("Capture audit logs");
    expect(calls.some(({ init }) => init?.method === "PATCH")).toBe(false);
  }, { reply: (path) => path.includes("usage") ? kind === "loading" ? held.promise
    : kind === "read-error" ? { status: 503, payload: {} } : { payload: {} } : { payload: operationsPage() } });
});

test("failed capture-status refresh keeps verified state locked until a successful explicit refresh", async () => {
  let reads = 0;
  await withScreen(async ({ container, toggle, click, calls }) => {
    await toggle("Capture and storage");
    await click("Capture audit logs");
    expect(container.textContent).toContain("Could not verify capture status");
    expect(captureSwitch(container).disabled).toBe(true);
    expect(captureSwitch(container).getAttribute("aria-checked")).toBe("true");
    await click("Refresh status");
    expect(captureSwitch(container).disabled).toBe(false);
    expect(calls.filter(({ init }) => init?.method === "PATCH")).toHaveLength(1);
  }, { reply: (path, init) => init?.method === "PATCH" ? { status: 409, payload: { error: "audit_policy_changed" } }
    : path.includes("usage") && ++reads === 2 ? { status: 503, payload: {} } : { payload: path.includes("usage") ? auditUsage : operationsPage() } });
});

test.each([401, 403, 404])("capture conflict refresh propagates %s to the locked page", async (status) => {
  let reads = 0;
  await withScreen(async ({ container, toggle, click, calls }) => {
    await toggle("Capture and storage");
    await click("Capture audit logs");
    expect(container.querySelector('[data-testid="audit-locked"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Team models");
    expect(calls.filter(({ init }) => init?.method === "PATCH")).toHaveLength(1);
  }, { reply: (path, init) => init?.method === "PATCH" ? { status: 409, payload: { error: "audit_policy_changed" } }
    : path.includes("usage") && ++reads > 1 ? { status, payload: { error: status === 404 ? "organization_not_found" : "forbidden" } }
      : { payload: path.includes("usage") ? auditUsage : operationsPage() } });
});

test("conflict refresh cannot write back after switching organizations", async () => {
  const held = deferred<Reply>();
  let reads = 0;
  await withScreen(async ({ toggle, click, rerender, flush, client, calls }) => {
    await toggle("Capture and storage");
    await click("Capture audit logs");
    const request = calls.filter(({ path }) => path.includes("usage")).at(-1);
    await rerender(auditDashboard("org-b"));
    expect(request?.init?.signal?.aborted).toBe(true);
    const apply = spyOn(client, "setQueryData");
    try {
      await act(async () => held.resolve({ payload: captureUsage(false) }));
      await flush();
      expect(apply).not.toHaveBeenCalled();
      expect(calls.filter(({ init }) => init?.method === "PATCH")).toHaveLength(1);
    } finally { apply.mockRestore(); }
  }, { reply: (path, init) => init?.method === "PATCH" ? { status: 409, payload: { error: "audit_policy_changed" } }
    : path.includes("usage") && ++reads > 1 ? held.promise : { payload: path.includes("usage") ? auditUsage : operationsPage() } });
});

test("ordinary usage refresh failure disables capture despite retained verified data", async () => {
  let reads = 0;
  await withScreen(async ({ container, toggle, click, calls }) => {
    await toggle("Capture and storage");
    await click("Refresh history");
    expect(captureSwitch(container).disabled).toBe(true);
    expect(container.textContent).toContain("Showing the last verified state");
    await click("Capture audit logs");
    expect(calls.some(({ init }) => init?.method === "PATCH")).toBe(false);
  }, { reply: (path) => path.includes("usage") && ++reads > 1 ? { status: 503, payload: {} } : { payload: path.includes("usage") ? auditUsage : operationsPage() } });
});

test.each(["verify", "cancel", "org", "member", "role", "unmount"])("delayed reauth callback is pinned and invalidated on %s", async (transition) => {
  const resume = deferred<void>();
  let replay: () => Promise<void> = async () => { throw new Error("No reauth callback"); };
  let patches = 0;
  const state = auditDashboard();
  state.runReauthableAction = async (_label, action) => {
    try { await action(); }
    catch (error) {
      if (!requests.isReauthRequiredError(error)) throw error;
      replay = action;
      await resume.promise;
      await action();
    }
  };
  await withScreen(async ({ container, toggle, click, rerender, unmount, flush, calls }) => {
    await toggle("Capture and storage");
    await click("Capture audit logs");
    expect(patches).toBe(1);
    expect(captureSwitch(container).disabled).toBe(true);
    if (transition === "org") await rerender(auditDashboard("org-b"));
    if (transition === "role") await rerender(auditDashboard("org-a", "admin"));
    if (transition === "member") {
      const next = auditDashboard();
      if (!next.orgContext) throw new Error("Missing org");
      next.orgContext.currentMember.id = "replacement-member";
      await rerender(next);
    }
    if (transition === "unmount") await unmount();
    await act(async () => { if (transition === "cancel") resume.reject(new Error("Reauthentication canceled")); else resume.resolve(); });
    await flush();
    expect(patches).toBe(transition === "verify" ? 2 : 1);
    if (transition === "verify") {
      const requests = calls.filter(({ init }) => init?.method === "PATCH");
      for (const { init } of requests) {
        expect(new Headers(init?.headers).get("x-openwork-org-id")).toBe("org-a");
        expect(JSON.parse(String(init?.body))).toEqual({ captureOn: false, expectedRevision: 1 });
      }
      expect(captureSwitch(container).getAttribute("aria-checked")).toBe("false");
    } else {
      if (transition === "cancel") expect(container.textContent).toContain("Capture change was not sent");
      await expect(replay()).rejects.toThrow();
      expect(patches).toBe(1);
    }
  }, { state, reply: (path, init) => {
    if (init?.method === "PATCH") return ++patches === 1 ? { status: 403, payload: { error: "reauth", reason: "fresh_session_required" } } : { payload: captureUsage(false) };
    return { payload: path.includes("usage") ? auditUsage : operationsPage() };
  } });
});

test.each(["org", "member", "role", "unmount"])("late PATCH response after %s cannot update any usage cache", async (transition) => {
  const held = deferred<Reply>();
  await withScreen(async ({ container, toggle, click, calls, rerender, unmount, client, flush }) => {
    await toggle("Capture and storage");
    await click("Capture audit logs");
    const request = calls.find(({ init }) => init?.method === "PATCH");
    const otherKey = ["audit", "org-b", "member-org-b", "usage"];
    const otherUsage = captureUsage(true, { policy: { ...auditPolicy, organizationId: "org-b" } });
    client.setQueryDefaults(otherKey, { gcTime: Infinity });
    client.setQueryData(otherKey, otherUsage);
    if (transition === "org") await rerender(auditDashboard("org-b"));
    if (transition === "role") await rerender(auditDashboard("org-a", "member"));
    if (transition === "member") {
      const next = auditDashboard();
      if (!next.orgContext) throw new Error("Missing org");
      next.orgContext.currentMember.id = "replacement-member";
      await rerender(next);
    }
    if (transition === "unmount") await unmount();
    expect(request?.init?.signal?.aborted).toBe(true);
    const apply = spyOn(client, "setQueryData");
    try {
      await act(async () => held.resolve({ payload: captureUsage(false) }));
      await flush();
      expect(apply).not.toHaveBeenCalled();
      expect(client.getQueryData(otherKey)).toEqual(otherUsage);
      expect(container.textContent).not.toContain("capture change could not be verified");
    } finally { apply.mockRestore(); }
  }, { reply: (path, init) => init?.method === "PATCH" ? held.promise : { payload: path.includes("usage") ? auditUsage : operationsPage() } });
});

test("all outcome values are explicit and unknown never becomes success", () => {
  for (const outcome of ["running", "succeeded", "failed", "partial", "unknown", "denied"] satisfies Parameters<typeof AuditOutcome>[0]["outcome"][]) {
    const html = renderToStaticMarkup(<AuditOutcome outcome={outcome} />);
    if (outcome !== "succeeded") expect(html).not.toContain("Succeeded");
    if (outcome === "unknown") expect(html).toContain("Unknown");
  }
});

test("diffs keep null, missing, false and redacted credentials distinct", () => {
  const html = renderToStaticMarkup(<AuditChanges changes={{ before: { enabled: false, name: null, apiKey: "never-show-this" }, after: { enabled: true, settings: { region: "west" }, apiKey: "never-show-that" }, changedFields: ["enabled", "name", "settings", "apiKey"] }} />);
  for (const text of ["No", "Yes", "None", "Not recorded", "Region: west", "Hidden"]) expect(html).toContain(text);
  expect(html).not.toContain("never-show");
  expect(html).not.toContain("<pre");
  expect(renderToStaticMarkup(<AuditUsageFacts usage={{ ...auditUsage, policy: null, captureEnabled: false }} />)).toContain("Not configured");
  expect(getAuditAccess({ ...auditDashboard(), orgId: null })).toBe("checking");
});
