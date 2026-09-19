import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { writeDenSettings } from "../src/app/lib/den";
import { gatewayUsageQueryPrefix, gatewayUsageNoticeState, parseGatewayUsageError, type GatewayUsageErrorEvidence } from "../src/react-app/domains/cloud/gateway-usage-state";
import { gatewayUsageLimitResponse } from "@openwork/types/den/gateway-usage-limits";
import { approvedUsageStatus, trackedCoverage, usageStatus } from "./gateway-usage-fixture";
import { readGatewayUsageScope } from "../src/app/lib/gateway-usage-scope";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { QueryClientProvider, focusManager, isServer } = await import("@tanstack/react-query");
const { getReactQueryClient } = await import("../src/react-app/infra/query-client");
const { disposeGatewayUsageRefresh, refreshGatewayUsageAfterCompletion, refreshGatewayUsageAfterCloudSync } = await import("../src/react-app/domains/cloud/gateway-usage-refresh");
let organizationId = "org_test";
let signedIn = true;
let principalId = "user_test";
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({
  useDenAuth: () => ({ isSignedIn: signedIn, verifiedIdentity: signedIn ? { organizationId, principalId } : null }),
}));
const { GatewayUsageSummary, GatewayUsageNotice, GatewayUsageTrigger, GatewayResetForm, GatewayUsageApprovalNotice } = await import("../src/react-app/domains/cloud/gateway-usage-panel");
const { useGatewayApprovalDismissals, GATEWAY_APPROVAL_DISMISSALS_KEY } = await import("../src/react-app/domains/cloud/gateway-usage-approval-store");
const { useGatewayUsage, useGatewayUsageErrorHandled } = await import("../src/react-app/domains/cloud/use-gateway-usage");
const { __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest } = await import("../src/react-app/domains/session/sync/session-sync");
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let container: HTMLDivElement;
let current: ReturnType<typeof useGatewayUsage> | undefined;
let enabled = true;
let refreshKey = "session-a:idle";
let status = usageStatus();
let readFailure = false;
let pendingRead: Promise<Response> | undefined;
let reads = 0;
let writes = 0;
let submitted: unknown;
let evidence: GatewayUsageErrorEvidence | null = null;
let hasError = false;
let paneCount = 1;
let modelId = "model-a";
let providerScope: number | null | undefined;
let settled = false;
let ownPanelActive = false;
let approvalNotices = false;

function latest() {
  if (!current) throw new Error("Missing hook");
  return current;
}
function Probe() {
  current = useGatewayUsage(enabled, false, JSON.stringify([refreshKey, modelId]), settled, providerScope);
  const handled = useGatewayUsageErrorHandled({ scopeKey: current.scopeKey, sessionOwner: "session-a", errorKey: "turn", gatewaySelected: current.active, status: current.data, evidence });
  const notice = gatewayUsageNoticeState({ gatewaySelected: current.active, status: current.data });
  return <div>{current.data?.organizationId ?? "no data"}:{current.query.isError ? "error" : current.data?.state ?? "loading"}
    {approvalNotices ? <><GatewayUsageApprovalNotice /><GatewayUsageTrigger /></> : null}
    {notice && current.data ? <GatewayUsageNotice state={notice} status={current.data} stale={current.query.isError} /> : null}
    {hasError && !handled ? <p>Provider error</p> : null}
  </div>;
}
function OwnPanelProbe() { useGatewayUsage(true); return null; }
function renderProbe() {
  root?.render(<QueryClientProvider client={getReactQueryClient()}>{ownPanelActive ? <OwnPanelProbe /> : null}{Array.from({ length: paneCount }, (_, index) => <Probe key={index} />)}</QueryClientProvider>);
}
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); }
function expectTitleOnlySurface(slot: "popover" | "dialog", name: string) {
  const surface = document.querySelector(`[data-slot="${slot}-content"]`);
  const title = surface?.querySelector(`[data-slot="${slot}-title"]`);
  if (!surface || !title) throw new Error(`Missing ${slot} title`);
  expect(title.textContent).toBe(name);
  expect(title.id).not.toBe("");
  expect(surface.getAttribute("aria-labelledby")).toBe(title.id);
  expect(surface.hasAttribute("aria-describedby")).toBe(false);
  expect(surface.querySelector(`[data-slot="${slot}-description"]`)).toBeNull();
}
function changeSettings(org = "org_test", token = "member-token") {
  writeDenSettings({ baseUrl: "https://den.test", activeOrgId: org, authToken: token }, { persistBootstrap: false });
}

beforeEach(() => {
  organizationId = "org_test";
  principalId = "user_test";
  useGatewayApprovalDismissals.setState({ dismissedKeys: [] });
  signedIn = true;
  enabled = true;
  refreshKey = "session-a:idle";
  evidence = null;
  hasError = false;
  paneCount = 1;
  modelId = "model-a";
  providerScope = undefined;
  settled = false;
  ownPanelActive = false;
  approvalNotices = false;
  reads = 0;
  writes = 0;
  readFailure = false;
  pendingRead = undefined;
  current = undefined;
  status = usageStatus();
  changeSettings();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes++;
      submitted = typeof init.body === "string" ? JSON.parse(init.body) : null;
      status = { ...status, buckets: status.buckets.map((bucket) => ({ ...bucket, canRequestReset: false, resetRequestStatus: "pending" })) };
      return Response.json({ id: "request_test", memberId: "member_test", memberName: "Test", memberEmail: "test@example.test", bucketId: "bucket_test", timeframe: "day", policyName: "Standard", reason: "Finish task", status: "pending", createdAt: status.serverTime, reviewedAt: null, reviewedBy: null, baseAllowanceMicroUsd: 1_000_000, allowanceMicroUsd: 1_000_000, usedMicroUsd: 1_300_000, resetAt: "2026-09-16T05:00:00.000Z" });
    }
    reads++;
    if (pendingRead) return pendingRead;
    return readFailure ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json(status);
  } });
});
afterEach(async () => {
  disposeGatewayUsageRefresh();
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  getReactQueryClient().clear();
  globalThis.fetch = originalFetch;
  focusManager.setFocused(undefined);
});

test("summary presents day/week/month micro-USD, base/extension, hard/soft, pending and incomplete estimates", () => {
  const first = status.buckets[0];
  const html = renderToStaticMarkup(<GatewayUsageSummary status={{ ...status, coverage: { complete: false, unpricedRequests: 2 }, buckets: [first, { ...first, id: "week", timeframe: "week", hardLimit: false, canRequestReset: false, resetRequestStatus: "pending" }, { ...approvedUsageStatus().buckets[0], id: "month", timeframe: "month", usedMicroUsd: 1_000_000, remainingMicroUsd: 250_000, canRequestReset: false }] }} onRequest={() => {}} />);
  for (const text of ["Daily", "Weekly", "Monthly", "1.30", "1.00", "1.25", "Base", "Extension", "0.00", "0.25", "Hard limit", "Soft limit", "Incomplete accounting", "Increase request pending", "approved", "Running sessions not reflected in usage above", "GMT"]) expect(html).toContain(text);
  expect(html).toContain("<dt>Base</dt><dd>$1.00</dd>");
  expect(html).toContain("<dt>Extension</dt><dd>$0.25</dd>");
  expect(html).toContain("<dt>Status</dt><dd>Exhausted</dd>");
  expect(html).toContain("<dt>Over allowance</dt><dd>$0.30</dd>");
  expect(html).not.toContain("·");
  expect(html).toContain("Request Increase — Daily");
  expect(html).not.toContain("Request Increase — Weekly");
  expect(html).not.toContain("Request Increase — Monthly");
  expect(renderToStaticMarkup(<GatewayUsageSummary status={usageStatus({ state: "unlimited", buckets: [] })} onRequest={() => {}} />)).toContain("No usage limit policy assigned");
});

test.each([
  { name: "settled writes with an unknown earlier period", coverage: trackedCoverage(), shown: ["This period includes time before usage tracking started", "Earlier usage is unknown", "Usage tracking started:", "No tracked requests are awaiting settlement", "Last settlement:"], hidden: ["0 recorded requests", "coverage complete"] },
  { name: "tracking not started", coverage: trackedCoverage({ historicalUnknownReason: "tracking_not_started", trackingStartedAt: null, pendingRequests: null, settlementReady: false, lastSettlementAt: null, lastSettlementRequestId: null }), shown: ["Usage tracking has not started", "Pending settlement count is unavailable"], hidden: ["0 recorded requests", "No tracked requests", "Last settlement:", "Usage tracking started:"] },
  { name: "separate pending, unpriced and incomplete counts", coverage: trackedCoverage({ pendingRequests: 2, settlementReady: false, unpricedRequests: 3, incompleteRequests: 4 }), shown: ["2 tracked requests are awaiting settlement", "3 recorded requests have unresolved cost", "4 recorded requests have incomplete accounting", "Unknown cost is not zero"], hidden: ["No tracked requests", "9 recorded requests", "coverage complete"] },
  { name: "settlement does not resolve unknown costs", coverage: trackedCoverage({ unpricedRequests: 3, incompleteRequests: 4 }), shown: ["No tracked requests are awaiting settlement", "3 recorded requests have unresolved cost", "4 recorded requests have incomplete accounting"], hidden: ["coverage complete"] },
  { name: "legacy zero counts with incomplete coverage", coverage: { complete: false, unpricedRequests: 0 }, shown: ["Incomplete accounting", "Known costs are a subtotal"], hidden: ["0 requests", "0 recorded requests", "tracking has not started", "No tracked requests"] },
  { name: "legacy counters with unknown history", coverage: trackedCoverage({ historicalUnknownReason: "legacy_counter" }), shown: ["older counters with unknown coverage"], hidden: ["coverage complete", "0 recorded requests"] },
])("coverage copy distinguishes $name", ({ coverage, shown, hidden }) => {
  const html = renderToStaticMarkup(<GatewayUsageSummary status={usageStatus({ state: "unlimited", buckets: [], coverage })} onRequest={() => {}} />);
  for (const text of shown) expect(html).toContain(text);
  for (const text of hidden) expect(html).not.toContain(text);
  expect(html).toContain("No usage limit policy assigned");
  expect(html).toContain("Running sessions not reflected in usage above");
  expect(html).not.toContain("request_settled");
});

test("hard/soft notices retain usage controls and stale truth disables only the increase action", async () => {
  await act(async () => root?.render(<QueryClientProvider client={getReactQueryClient()}><GatewayUsageNotice state="blocked" status={status} stale={true} /></QueryClientProvider>));
  expect(container.textContent).toContain("Out of usage");
  expect(container.textContent).toContain("You've consumed the AI usage limits assigned to you.");
  expect(container.textContent).toContain("You can request an increase to your limits here:");
  const notice = container.querySelector('[data-testid="gateway-usage-notice"]');
  expect(notice?.classList.contains("text-destructive")).toBe(false);
  expect(notice?.classList.contains("text-card-foreground")).toBe(true);
  expect(notice?.querySelector('svg[aria-hidden="true"]')?.classList.contains("lucide-lock-keyhole")).toBe(true);
  expect(container.textContent).toContain("Consumed Limit: Standard - Daily");
  expect(container.textContent).toContain("Could not refresh usage");
  const increase = [...container.querySelectorAll("button")].find((button) => button.textContent === "Request Increase");
  expect(increase?.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[aria-label="View Usage Limits"]')?.disabled).toBe(false);
  expect(container.querySelector("time")?.hasAttribute("title")).toBe(false);
  await act(async () => root?.render(<QueryClientProvider client={getReactQueryClient()}><GatewayUsageNotice state="over_limit" status={{ ...status, state: "over_limit" }} stale={false} /></QueryClientProvider>));
  expect(container.textContent).toContain("Requests are still allowed");
  expect(container.textContent).not.toContain("Out of usage");
});

test("reason form rejects blank and submits trimmed input", async () => {
  const reasons: string[] = [];
  await act(async () => root?.render(<GatewayResetForm bucket={status.buckets[0]} pending={false} error={false} onSubmit={(reason) => reasons.push(reason)} />));
  const button = container.querySelector("button");
  const textarea = container.querySelector("textarea");
  const form = container.querySelector("form");
  if (!button || !textarea || !form) throw new Error("Missing form controls");
  expect(button.disabled).toBe(true);
  expect(textarea.required).toBe(true);
  expect(container.querySelector("label")?.htmlFor).toBe(textarea.id);
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(reasons).toHaveLength(0);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => { setter?.call(textarea, " Finish task "); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(reasons).toEqual(["Finish task"]);
});

test("trigger observes approval before opening and panel exposes a titled loading/error state", async () => {
  let resolveRead: ((value: Response) => void) | undefined;
  pendingRead = new Promise((resolve) => { resolveRead = resolve; });
  await act(async () => root?.render(<QueryClientProvider client={getReactQueryClient()}><GatewayUsageTrigger /></QueryClientProvider>));
  expect(reads).toBe(1);
  expect(document.querySelector('[data-slot="popover-title"]')).toBeNull();
  const button = container.querySelector("button");
  if (!button) throw new Error("Missing usage button");
  await act(async () => button.click());
  await flush();
  expect(reads).toBeGreaterThan(0);
  expect(document.body.textContent).toContain("Loading usage limits");
  expectTitleOnlySurface("popover", "Usage limits");
  expect(document.body.textContent).not.toContain("Your organization’s AI Gateway estimated cost.");
  await act(async () => resolveRead?.(Response.json({ error: "unavailable" }, { status: 503 })));
  await flush();
  expect(document.body.textContent).toContain("does not mean unlimited access");
  expect(document.querySelector('[data-slot="popover-content"] [role="alert"]')?.classList.contains("text-destructive")).toBe(true);
});

test("closed and open usage never schedule polling; opening and manual refresh fetch even fresh data", async () => {
  const interval = spyOn(globalThis, "setInterval");
  status = usageStatus({ state: "within_limit" });
  status.buckets[0].resetAt = "2099-01-01T05:00:00.000Z";
  try {
    await act(async () => root?.render(<QueryClientProvider client={getReactQueryClient()}><GatewayUsageTrigger /></QueryClientProvider>));
    await flush();
    expect(reads).toBe(1);
    expect(document.querySelector('[data-slot="popover-title"]')).toBeNull();
    const trigger = container.querySelector("button");
    if (!trigger) throw new Error("Missing usage trigger");
    await act(async () => trigger.click());
    await flush();
    expect(reads).toBe(2);
    const refresh = [...document.querySelectorAll("button")].find((button) => button.textContent === "Refresh usage");
    if (!refresh) throw new Error("Missing refresh button");
    await act(async () => refresh.click());
    await flush();
    expect(reads).toBe(3);
    for (const state of ["blocked", "over_limit", "within_limit"] satisfies Array<typeof status.state>) {
      status = { ...status, state, buckets: status.buckets.map((bucket) => ({ ...bucket, resetRequestStatus: "pending" })) };
      await act(async () => { await refreshGatewayUsageAfterCloudSync(readGatewayUsageScope()); });
      await flush();
    }
    await act(async () => trigger.click());
    await flush();
    expect(interval.mock.calls.some((call) => call[1] === 30_000)).toBe(false);
  } finally { interval.mockRestore(); }
});

test("eligible bucket opens a titled reset dialog and pending status removes its action", async () => {
  await act(async () => root?.render(<QueryClientProvider client={getReactQueryClient()}><GatewayUsageTrigger /></QueryClientProvider>));
  const trigger = container.querySelector("button");
  if (!trigger) throw new Error("Missing usage trigger");
  await act(async () => trigger.click());
  await flush();
  const request = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Request Increase — Daily"));
  if (!request) throw new Error("Missing eligible reset action");
  await act(async () => request.click());
  await flush();
  expectTitleOnlySurface("dialog", "Request Increase");
  expect(document.querySelector('[data-slot="dialog-content"]')?.textContent).toContain("Each approval adds 25% of the base allowance; usage and reset time are unchanged.");
  expect(document.body.textContent).not.toContain("Ask your organization administrator");
  expect(document.querySelector("textarea")?.required).toBe(true);
  status = { ...status, buckets: status.buckets.map((bucket) => ({ ...bucket, canRequestReset: false, resetRequestStatus: "pending" })) };
  await act(async () => { await getReactQueryClient().invalidateQueries({ queryKey: gatewayUsageQueryPrefix }); });
  await flush();
  expect(document.body.textContent).toContain("Increase request pending");
  expect(document.body.textContent).not.toContain("Request Increase — Daily");
});

test("direct notice opens an increase dialog with a required reason and submits only once", async () => {
  await act(async () => renderProbe());
  await flush();
  const request = [...container.querySelectorAll("button")].find((button) => button.textContent === "Request Increase");
  if (!request) throw new Error("Missing direct increase action");
  await act(async () => request.click());
  await flush();
  const dialog = document.querySelector('[role="dialog"]');
  expectTitleOnlySurface("dialog", "Request Increase");
  expect(dialog?.textContent).toContain("Each approval adds 25% of the base allowance; usage and reset time are unchanged.");
  expect(dialog?.textContent).not.toContain("Ask your organization administrator");
  const textarea = dialog?.querySelector("textarea");
  const submit = dialog?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!textarea || !submit) throw new Error("Missing dialog form");
  expect(submit.textContent).toBe("Request Increase");
  expect(submit.disabled).toBe(true);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, " Finish task ");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => submit.click());
  await flush();
  expect(writes).toBe(1);
  expect(submitted).toEqual({ bucketId: "bucket_test", reason: "Finish task" });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Request Increase")).toBe(false);
});

test("pending is amber and Cloud sync refresh discovers approval across closed non-Gateway session panes", async () => {
  expect(isServer).toBe(false);
  enabled = false;
  approvalNotices = true;
  paneCount = 2;
  status = { ...status, state: "within_limit", buckets: status.buckets.map((bucket) => ({ ...bucket, usedMicroUsd: 800_000, remainingMicroUsd: 200_000, resetAt: "2099-01-01T05:00:00.000Z", resetRequestStatus: "pending", canRequestReset: false })) };
  await act(async () => root?.render(<QueryClientProvider client={getReactQueryClient()}><GatewayUsageSummary status={status} onRequest={() => {}} /></QueryClientProvider>));
  const pending = container.querySelector('[role="status"]');
  expect(pending?.textContent).toBe("Increase request pending");
  expect(pending?.classList.contains("bg-amber-3")).toBe(true);
  expect(pending?.classList.contains("text-amber-11")).toBe(true);
  await act(async () => renderProbe());
  await flush();
  expect(container.querySelector('[data-testid="gateway-usage-approved-notice"]')).toBeNull();
  expect(latest().active).toBe(false);
  const before = reads;
  status = approvedUsageStatus();
  status.buckets[0].resetAt = "2099-01-01T05:00:00.000Z";
  await act(async () => { await refreshGatewayUsageAfterCloudSync(readGatewayUsageScope()); });
  await flush();
  expect(reads).toBe(before + 1);
  const notices = container.querySelectorAll('[data-testid="gateway-usage-approved-notice"]');
  expect(notices).toHaveLength(2);
  const gauges = container.querySelectorAll('[aria-label="Usage limits"]');
  expect(gauges).toHaveLength(2);
  for (const gauge of gauges) {
    expect(gauge.getAttribute("title")).toBe("Usage increase approved");
    expect(gauge.querySelector("svg")?.classList.contains("text-green-11")).toBe(true);
  }
  for (const notice of notices) {
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.classList.contains("bg-green-3")).toBe(true);
    expect(notice.textContent).toContain("Standard - Daily: +$0.25 ($1.25 total)");
    expect(notice.textContent).toContain("One or more usage limits are still exhausted");
    expect(notice.querySelector('button svg')?.classList.contains("text-green-11")).toBe(true);
  }
  expect(container.querySelector('[data-testid="gateway-usage-notice"]')).toBeNull();
  expect(document.querySelector('[data-slot="popover-title"]')).toBeNull();
});

test.each(["button", "icon"])("approval %s dismisses all sessions, survives rehydration, and leaves future approvals visible", async (control) => {
  enabled = false;
  approvalNotices = true;
  paneCount = 2;
  status = approvedUsageStatus();
  status.buckets[0].resetAt = "2099-01-01T05:00:00.000Z";
  await act(async () => renderProbe());
  await flush();
  const notices = () => container.querySelectorAll('[data-testid="gateway-usage-approved-notice"]');
  expect(notices()).toHaveLength(2);
  const button = control === "icon"
    ? container.querySelector<HTMLButtonElement>('[aria-label="Dismiss usage increase approval"]')
    : [...container.querySelectorAll("button")].find((item) => item.textContent === "Dismiss");
  if (!button) throw new Error("Missing dismissal control");
  await act(async () => button.click());
  expect(notices()).toHaveLength(0);
  expect(writes).toBe(0);
  expect(latest().data?.buckets[0].resetRequestStatus).toBe("approved");
  expect(container.querySelector('[aria-label="Usage limits"]')).not.toBeNull();
  // Restore only the persisted data, as a fresh renderer would on restart.
  const saved = localStorage.getItem(GATEWAY_APPROVAL_DISMISSALS_KEY);
  expect(saved).not.toBeNull();
  expect(saved).not.toContain("member-token");
  await act(async () => {
    root?.unmount();
    useGatewayApprovalDismissals.setState({ dismissedKeys: [] });
    if (saved) localStorage.setItem(GATEWAY_APPROVAL_DISMISSALS_KEY, saved);
    await useGatewayApprovalDismissals.persist.rehydrate();
    root = createRoot(container);
    refreshKey = "session-new:idle";
    changeSettings(organizationId, "rotated-token");
    renderProbe();
  });
  await flush();
  expect(notices()).toHaveLength(0);
  await act(async () => { await latest().query.refetch(); });
  await flush();
  expect(notices()).toHaveLength(0);
  const first = status.buckets[0];
  status = { ...status, buckets: [first, { ...first, id: "another-bucket", policyName: "Another" }] };
  await act(async () => { await latest().query.refetch(); });
  await flush();
  expect(notices()).toHaveLength(2);
  expect(notices()[0].textContent).toContain("Another - Daily");
  expect(notices()[0].textContent).not.toContain("Standard - Daily");
  status = { ...status, buckets: [{ ...first, resetAt: "2099-01-02T05:00:00.000Z" }] };
  await act(async () => { await latest().query.refetch(); });
  await flush();
  expect(notices()).toHaveLength(2);
});

test("approval dismissals are scoped to control plane, organization and user", async () => {
  approvalNotices = true;
  status = approvedUsageStatus();
  status.buckets[0].resetAt = "2099-01-01T05:00:00.000Z";
  await act(async () => renderProbe());
  await flush();
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Dismiss usage increase approval"]');
  if (!button) throw new Error("Missing dismissal control");
  await act(async () => button.click());
  for (const identity of [
    { org: "org_next", user: "user_test", origin: "https://den.test", shown: true },
    { org: "org_test", user: "other_user", origin: "https://den.test", shown: true },
    { org: "org_test", user: "user_test", origin: "https://other-den.test", shown: true },
    { org: "org_test", user: "user_test", origin: "https://den.test", shown: false },
  ]) {
    await act(async () => {
      organizationId = identity.org;
      principalId = identity.user;
      status = { ...status, organizationId };
      writeDenSettings({ baseUrl: identity.origin, activeOrgId: organizationId, authToken: "member-token" }, { persistBootstrap: false });
      renderProbe();
    });
    await flush();
    expect(Boolean(container.querySelector('[data-testid="gateway-usage-approved-notice"]'))).toBe(identity.shown);
  }
});

test("malformed dismissal storage is ignored and a failed write still dismisses every pane", async () => {
  for (const stored of ["{broken", JSON.stringify({ state: { dismissedKeys: [42] }, version: 0 })]) {
    localStorage.setItem(GATEWAY_APPROVAL_DISMISSALS_KEY, stored);
    await useGatewayApprovalDismissals.persist.rehydrate();
    expect(useGatewayApprovalDismissals.getState().dismissedKeys).toEqual([]);
  }
  approvalNotices = true;
  paneCount = 2;
  status = approvedUsageStatus();
  status.buckets[0].resetAt = "2099-01-01T05:00:00.000Z";
  await act(async () => renderProbe());
  await flush();
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Dismiss usage increase approval"]');
  if (!button) throw new Error("Missing dismissal control");
  const originalSetItem = localStorage.setItem;
  localStorage.setItem = () => { throw new Error("Storage full"); };
  try {
    await act(async () => button.click());
    expect(container.querySelectorAll('[data-testid="gateway-usage-approved-notice"]')).toHaveLength(0);
  } finally {
    localStorage.setItem = originalSetItem;
  }
});

test("approval notice and gauge reject stale, expired, zero-extension, switched-org and signed-out truth", async () => {
  enabled = false;
  approvalNotices = true;
  status = approvedUsageStatus();
  status.buckets[0].resetAt = "2099-01-01T05:00:00.000Z";
  await act(async () => renderProbe());
  await flush();
  expect(container.querySelector('[data-testid="gateway-usage-approved-notice"]')).not.toBeNull();
  readFailure = true;
  await act(async () => { await latest().query.refetch(); });
  await flush();
  expect(container.querySelector('[data-testid="gateway-usage-approved-notice"]')).toBeNull();
  expect(container.querySelector('[aria-label="Usage limits"] svg')?.classList.contains("text-green-11")).toBe(false);
  readFailure = false;
  const approvedBucket = status.buckets[0];
  for (const bucket of [{ ...approvedBucket, extensionMicroUsd: 0 }, { ...approvedBucket, resetAt: "2020-01-01T05:00:00.000Z" }, { ...approvedBucket, resetRequestStatus: "denied" } satisfies typeof approvedBucket]) {
    status = { ...status, buckets: [bucket] };
    await act(async () => { await latest().query.refetch(); });
    await flush();
    expect(container.querySelector('[data-testid="gateway-usage-approved-notice"]')).toBeNull();
    expect(container.querySelector('[aria-label="Usage limits"] svg')?.classList.contains("text-green-11")).toBe(false);
  }
  status = approvedUsageStatus();
  status.buckets[0].resetAt = "2099-01-01T05:00:00.000Z";
  await act(async () => { await latest().query.refetch(); });
  await flush();
  expect(container.querySelector('[data-testid="gateway-usage-approved-notice"]')).not.toBeNull();
  let resolveRead: ((value: Response) => void) | undefined;
  pendingRead = new Promise((resolve) => { resolveRead = resolve; });
  await act(async () => { void latest().query.refetch(); });
  await act(async () => {
    organizationId = "org_next";
    status = usageStatus({ organizationId, state: "unlimited", buckets: [] });
    changeSettings(organizationId);
    pendingRead = undefined;
    renderProbe();
  });
  await flush();
  const oldApproval = approvedUsageStatus();
  oldApproval.buckets[0].resetAt = "2099-01-01T05:00:00.000Z";
  await act(async () => resolveRead?.(Response.json(oldApproval)));
  await flush();
  expect(latest().data?.organizationId).toBe("org_next");
  expect(container.querySelector('[data-testid="gateway-usage-approved-notice"]')).toBeNull();
  expect(container.querySelector('[aria-label="Usage limits"] svg')?.classList.contains("text-green-11")).toBe(false);
  expect(getReactQueryClient().getQueryCache().findAll({ queryKey: gatewayUsageQueryPrefix }).some((query) => query.queryKey.includes("org_test"))).toBe(false);
  status = { ...oldApproval, organizationId };
  await act(async () => { await latest().query.refetch(); });
  await flush();
  expect(container.querySelector('[data-testid="gateway-usage-approved-notice"]')).not.toBeNull();
  await act(async () => { signedIn = false; changeSettings(organizationId, ""); renderProbe(); });
  expect(container.querySelector('[data-testid="gateway-usage-approved-notice"]')).toBeNull();
});

test("reset mutation refetches own truth and prevents a pending duplicate", async () => {
  await act(async () => renderProbe());
  await flush();
  const before = reads;
  await act(async () => { await latest().reset.mutateAsync({ bucketId: "bucket_test", reason: " Finish task " }); });
  await flush();
  expect(submitted).toEqual({ bucketId: "bucket_test", reason: "Finish task" });
  expect(writes).toBe(1);
  expect(reads).toBeGreaterThan(before);
  expect(latest().data?.buckets[0]).toMatchObject({
    resetRequestStatus: "pending", canRequestReset: false,
    baseAllowanceMicroUsd: 1_000_000, extensionMicroUsd: 0, allowanceMicroUsd: 1_000_000,
    usedMicroUsd: 1_300_000, remainingMicroUsd: -300_000,
  });
  await act(async () => {
    await expect(latest().reset.mutateAsync({ bucketId: "bucket_test", reason: "Duplicate" })).rejects.toThrow("eligibility");
  });
  await flush();
  expect(writes).toBe(1);
});

test("exhausted approved extension opens another reason form and pending prevents duplicates", async () => {
  status = approvedUsageStatus();
  const approved = status.buckets[0];
  expect(approved).toMatchObject({
    baseAllowanceMicroUsd: 1_000_000, extensionMicroUsd: 250_000, allowanceMicroUsd: 1_250_000,
    usedMicroUsd: 1_300_000, remainingMicroUsd: -50_000,
    canRequestReset: true, resetRequestStatus: "approved",
  });
  const html = renderToStaticMarkup(<GatewayUsageSummary status={status} onRequest={() => {}} />);
  expect(html).toContain("approved");
  expect(html).toContain("1.25");
  expect(html).toContain("0.25");
  expect(html).toContain("Request Increase — Daily");
  await act(async () => renderProbe());
  await flush();
  const request = [...container.querySelectorAll("button")].find((button) => button.textContent === "Request Increase");
  if (!request) throw new Error("Missing repeat increase action");
  await act(async () => request.click());
  await flush();
  const dialog = document.querySelector('[role="dialog"]');
  expectTitleOnlySurface("dialog", "Request Increase");
  expect(dialog?.textContent).toContain("$1.30 used / $1.25 total");
  expect(dialog?.textContent).toContain("Each approval adds 25% of the base allowance");
  const textarea = dialog?.querySelector("textarea");
  const submit = dialog?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!textarea || !submit) throw new Error("Missing repeat increase form");
  expect(textarea.required).toBe(true);
  expect(submit.disabled).toBe(true);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, " Another extension ");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => submit.click());
  await flush();
  expect(submitted).toEqual({ bucketId: approved.id, reason: "Another extension" });
  expect(writes).toBe(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Request Increase")).toBe(false);
  expect(latest().data?.buckets[0]).toMatchObject({
    ...approved, resetRequestStatus: "pending", canRequestReset: false,
  });
  const pendingHtml = renderToStaticMarkup(<GatewayUsageSummary status={status} onRequest={() => {}} />);
  expect(pendingHtml).toContain("Increase request pending");
  expect(pendingHtml).not.toContain("Request Increase — Daily");
  await act(async () => {
    await expect(latest().reset.mutateAsync({ bucketId: approved.id, reason: "Duplicate" })).rejects.toThrow("eligibility");
  });
  expect(writes).toBe(1);
});

test("approved extension with remaining allowance cannot request another increase", async () => {
  status = approvedUsageStatus();
  status = { ...status, state: "within_limit", buckets: status.buckets.map((bucket) => ({
    ...bucket, usedMicroUsd: 1_000_000, remainingMicroUsd: 250_000, canRequestReset: false,
  })) };
  const html = renderToStaticMarkup(<GatewayUsageSummary status={status} onRequest={() => {}} />);
  expect(html).toContain("approved");
  expect(html).not.toContain("Request Increase — Daily");
  await act(async () => renderProbe());
  await flush();
  expect(container.querySelector('[data-testid="gateway-usage-notice"]')).toBeNull();
  await act(async () => {
    await expect(latest().reset.mutateAsync({ bucketId: status.buckets[0].id, reason: "Too early" })).rejects.toThrow("eligibility");
  });
  expect(writes).toBe(0);
});

test("completion/session changes and focus revalidate, approvals clear state, failed refresh retains last truth", async () => {
  await act(async () => renderProbe());
  await flush();
  expect(latest().data?.state).toBe("blocked");
  const before = reads;
  status = usageStatus({ state: "within_limit" });
  refreshKey = "session-a:idle:completed-turn";
  await act(async () => renderProbe());
  await flush();
  expect(reads).toBeGreaterThan(before);
  expect(latest().data?.state).toBe("within_limit");
  readFailure = true;
  await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); });
  await flush();
  expect(latest().query.isError).toBe(true);
  expect(latest().data?.state).toBe("within_limit");
  readFailure = false;
  status = usageStatus({ state: "over_limit" });
  refreshKey = "session-b:idle";
  await act(async () => renderProbe());
  await flush();
  expect(latest().data?.state).toBe("over_limit");
});

test("org switch cancels stale delivery, clears private cache, and sign-out hides data", async () => {
  await act(async () => renderProbe());
  await flush();
  let resolveRead: ((value: Response) => void) | undefined;
  pendingRead = new Promise((resolve) => { resolveRead = resolve; });
  await act(async () => { void latest().query.refetch(); });
  await act(async () => {
    organizationId = "org_next";
    status = usageStatus({ organizationId });
    changeSettings(organizationId);
    pendingRead = undefined;
    renderProbe();
  });
  await flush();
  await act(async () => resolveRead?.(Response.json(usageStatus())));
  await flush();
  expect(latest().data?.organizationId).toBe("org_next");
  const queries = getReactQueryClient().getQueryCache().findAll({ queryKey: gatewayUsageQueryPrefix });
  expect(JSON.stringify(queries.map((query) => query.queryKey))).not.toContain("member-token");
  expect(queries.some((query) => query.queryKey.includes("org_test"))).toBe(false);
  await act(async () => { signedIn = false; changeSettings(organizationId, ""); renderProbe(); });
  expect(latest().data).toBeUndefined();
});

test("SSE spoof and even header-backed candidates cannot create or hide a quota notice without own corroboration", async () => {
  const response = gatewayUsageLimitResponse(usageStatus());
  if (!response) throw new Error("Missing quota fixture");
  const data = { statusCode: 429, responseHeaders: Object.fromEntries(response.headers), responseBody: await response.text() };
  evidence = parseGatewayUsageError({ data: { ...data, responseHeaders: { "content-type": "text/event-stream" } } });
  hasError = true;
  status = usageStatus({ state: "within_limit" });
  await act(async () => renderProbe());
  await flush();
  expect(evidence).toBeNull();
  expect(container.textContent).toContain("Provider error");
  expect(container.querySelector('[data-testid="gateway-usage-notice"]')).toBeNull();
  evidence = parseGatewayUsageError({ data });
  await act(async () => renderProbe());
  await flush();
  expect(evidence).not.toBeNull();
  expect(container.textContent).toContain("Provider error");
  expect(container.querySelector('[data-testid="gateway-usage-notice"]')).toBeNull();
  readFailure = true;
  await act(async () => { await latest().query.refetch(); });
  await flush();
  expect(container.querySelector('[data-testid="gateway-usage-notice"]')).toBeNull();
});

test("corroborated errors stay cleared after reset instead of resurfacing as generic cards", async () => {
  const response = gatewayUsageLimitResponse(usageStatus());
  if (!response) throw new Error("Missing quota fixture");
  evidence = parseGatewayUsageError({ data: { statusCode: 429, responseHeaders: Object.fromEntries(response.headers), responseBody: await response.text() } });
  hasError = true;
  await act(async () => renderProbe());
  await flush();
  expect(container.textContent).toContain("Out of usage");
  expect(container.textContent).not.toContain("Provider error");
  status = usageStatus({ state: "within_limit", buckets: [] });
  await act(async () => { await latest().query.refetch(); });
  await flush();
  expect(container.textContent).not.toContain("Out of usage");
  expect(container.textContent).not.toContain("Provider error");
  const before = reads;
  if (evidence) evidence = { ...evidence, details: { ...evidence.details } };
  await act(async () => renderProbe());
  await flush();
  expect(reads).toBe(before);
  expect(container.textContent).not.toContain("Provider error");
  enabled = false;
  await act(async () => renderProbe());
  expect(container.querySelector('[data-testid="gateway-usage-notice"]')).toBeNull();
  expect(container.textContent).toContain("Provider error");
});

test("pane mounts and equivalent rerenders share a fetch; selected model changes revalidate once", async () => {
  await act(async () => renderProbe());
  await flush();
  expect(reads).toBe(1);
  paneCount = 2;
  await act(async () => renderProbe());
  await flush();
  expect(reads).toBe(1);
  await act(async () => renderProbe());
  await flush();
  expect(reads).toBe(1);
  modelId = "model-b";
  await act(async () => renderProbe());
  await flush();
  expect(reads).toBe(2);
  await act(async () => renderProbe());
  await flush();
  expect(reads).toBe(2);
});

test("cached org B quota never labels an org A provider while sync is pending or failed", async () => {
  providerScope = readGatewayUsageScope().generation;
  ownPanelActive = true;
  await act(async () => renderProbe());
  await flush();
  expect(container.textContent).toContain("Out of usage");
  await act(async () => {
    organizationId = "org_b";
    status = usageStatus({ organizationId });
    changeSettings(organizationId, "token_b");
    renderProbe();
  });
  await flush();
  expect(latest().data?.organizationId).toBe("org_b");
  expect(latest().active).toBe(false);
  expect(container.querySelector('[data-testid="gateway-usage-notice"]')).toBeNull();
  providerScope = null;
  await act(async () => renderProbe());
  expect(container.querySelector('[data-testid="gateway-usage-notice"]')).toBeNull();
  providerScope = readGatewayUsageScope().generation;
  modelId = "verified-b-model";
  await act(async () => renderProbe());
  await flush();
  expect(latest().active).toBe(true);
  expect(container.textContent).toContain("Out of usage");
});

test("pending settlement after two seconds is discovered without requiring complete history or resolved costs", async () => {
  status = usageStatus({ state: "within_limit", coverage: trackedCoverage({ pendingRequests: 1, settlementReady: false, unpricedRequests: 1, incompleteRequests: 1 }) });
  status.buckets[0].hardLimit = false;
  await act(async () => renderProbe());
  await flush();
  await act(async () => { settled = true; refreshKey = "session-a:completed"; renderProbe(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
  await flush();
  expect(container.querySelector('[data-testid="gateway-usage-notice"]')).toBeNull();
  status = { ...status, state: "over_limit", coverage: trackedCoverage({ unpricedRequests: 1, incompleteRequests: 1 }) };
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5100)); });
  await flush();
  expect(container.textContent).toContain("Requests are still allowed");
  expect(latest().data?.coverage).toMatchObject({ complete: false, settlementReady: true, pendingRequests: 0, unpricedRequests: 1, incompleteRequests: 1 });
}, 15_000);

test("background successful terminal events refresh the foreground own status without a background pane", async () => {
  status = usageStatus({ state: "within_limit" });
  await act(async () => renderProbe());
  await flush();
  const input = { workspaceId: "background_workspace", baseUrl: "http://127.0.0.1:1234", openworkToken: "test-token" };
  const cleanup = __createWorkspaceSessionSyncForTest(input);
  try {
    __applySessionSyncEventForTest(input, { type: "session.execution.started", properties: { sessionID: "background_session", model: { providerID: "ipr_test" } } });
    const before = reads;
    status = usageStatus({ state: "over_limit" });
    await act(async () => { __applySessionSyncEventForTest(input, { type: "session.execution.succeeded", properties: { sessionID: "background_session" } }); });
    await flush();
    expect(reads).toBeGreaterThan(before);
    expect(container.textContent).toContain("Requests are still allowed");
    const settledReads = reads;
    await act(async () => { __applySessionSyncEventForTest(input, { type: "session.execution.succeeded", properties: { sessionID: "background_session" } }); });
    await flush();
    expect(reads).toBe(settledReads);
  } finally { cleanup(); }
});

test("known local-provider completions do not start Gateway settlement refreshes", async () => {
  status = usageStatus({ state: "within_limit" });
  await act(async () => renderProbe());
  await flush();
  const input = { workspaceId: "local_background", baseUrl: "http://127.0.0.1:1234", openworkToken: "test-token" };
  const cleanup = __createWorkspaceSessionSyncForTest(input);
  try {
    __applySessionSyncEventForTest(input, { type: "session.execution.started", properties: { sessionID: "local_session", model: { providerID: "ollama" } } });
    const before = reads;
    await act(async () => { __applySessionSyncEventForTest(input, { type: "session.execution.succeeded", properties: { sessionID: "local_session" } }); });
    await flush();
    expect(reads).toBe(before);
  } finally { cleanup(); }
});

test("a run started in org A cannot refresh org B on a late background completion", async () => {
  status = usageStatus({ state: "within_limit" });
  await act(async () => renderProbe());
  await flush();
  const input = { workspaceId: "old_org_background", baseUrl: "http://127.0.0.1:1234", openworkToken: "test-token" };
  const cleanup = __createWorkspaceSessionSyncForTest(input);
  try {
    __applySessionSyncEventForTest(input, { type: "session.execution.started", properties: { sessionID: "old_org_session", model: { providerID: "ipr_org_a" } } });
    await act(async () => {
      organizationId = "org_b";
      status = usageStatus({ organizationId, state: "within_limit" });
      changeSettings(organizationId);
      renderProbe();
    });
    await flush();
    const before = reads;
    await act(async () => { __applySessionSyncEventForTest(input, { type: "session.execution.succeeded", properties: { sessionID: "old_org_session" } }); });
    await flush();
    expect(reads).toBe(before);
  } finally { cleanup(); }
});

test("org changes cancel pending settlement timers", async () => {
  status = usageStatus({ state: "within_limit", coverage: trackedCoverage({ pendingRequests: 1, settlementReady: false }) });
  await act(async () => renderProbe());
  await flush();
  await act(async () => { refreshGatewayUsageAfterCompletion(readGatewayUsageScope().generation, "completed-a"); });
  await flush();
  await act(async () => {
    organizationId = "org_b";
    status = usageStatus({ organizationId, state: "within_limit" });
    changeSettings(organizationId);
    renderProbe();
  });
  await flush();
  const before = reads;
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
  await flush();
  expect(reads).toBe(before);
  expect(latest().data?.organizationId).toBe("org_b");
});

test("settled historical uncertainty stops completion retries in the real query cache", async () => {
  status = usageStatus({ state: "within_limit", coverage: trackedCoverage({ unpricedRequests: 2, incompleteRequests: 2 }) });
  await act(async () => renderProbe());
  await flush();
  const before = reads;
  await act(async () => { refreshGatewayUsageAfterCompletion(readGatewayUsageScope().generation, "settled-history"); });
  await flush();
  expect(reads).toBe(before + 1);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
  await flush();
  expect(reads).toBe(before + 1);
  expect(latest().data?.coverage).toMatchObject({ complete: false, settlementReady: true, unpricedRequests: 2, incompleteRequests: 2 });
});

test("sign-out cancels pending retries and a new sign-in can refresh the same completion key", async () => {
  status = usageStatus({ state: "within_limit", coverage: trackedCoverage({ pendingRequests: 1, settlementReady: false }) });
  await act(async () => renderProbe());
  await flush();
  const oldGeneration = readGatewayUsageScope().generation;
  await act(async () => { refreshGatewayUsageAfterCompletion(oldGeneration, "reused-key"); });
  await flush();
  await act(async () => { signedIn = false; changeSettings(organizationId, ""); renderProbe(); });
  const signedOutReads = reads;
  await act(async () => {
    refreshGatewayUsageAfterCompletion(oldGeneration, "late-old-turn");
    await new Promise((resolve) => setTimeout(resolve, 2200));
  });
  await flush();
  expect(reads).toBe(signedOutReads);
  expect(latest().data).toBeUndefined();
  await act(async () => { signedIn = true; status = usageStatus({ state: "within_limit", coverage: trackedCoverage() }); changeSettings(); renderProbe(); });
  await flush();
  const signedInReads = reads;
  await act(async () => { refreshGatewayUsageAfterCompletion(readGatewayUsageScope().generation, "reused-key"); });
  await flush();
  expect(reads).toBe(signedInReads + 1);
});

test("reset timer revalidates and clears blocked state without user interaction", async () => {
  const now = Date.now();
  status = usageStatus({ serverTime: new Date(now).toISOString() });
  status.buckets[0].resetAt = new Date(now + 100).toISOString();
  await act(async () => renderProbe());
  await flush();
  expect(latest().data?.state).toBe("blocked");
  const before = reads;
  status = usageStatus({ state: "within_limit", serverTime: new Date(now + 1000).toISOString(), buckets: [] });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
  await flush();
  expect(reads).toBeGreaterThan(before);
  expect(latest().data?.state).toBe("within_limit");
});

test("unrelated model scope performs no usage fetch and unmount removes observers", async () => {
  enabled = false;
  await act(async () => renderProbe());
  await flush();
  expect(reads).toBe(0);
  enabled = true;
  await act(async () => renderProbe());
  await flush();
  expect(reads).toBeGreaterThan(0);
  await act(async () => root?.unmount());
  root = undefined;
  await flush();
  expect(getReactQueryClient().getQueryCache().findAll({ queryKey: gatewayUsageQueryPrefix })).toHaveLength(0);
});
