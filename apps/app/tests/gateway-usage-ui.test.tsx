import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ReactNode } from "react";
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
const { GatewayUsageNotice, GatewayUsageMenuItem, GatewayIncreaseForm, GatewayUsageApprovalNotice, GatewayUsageSettingsView } = await import("../src/react-app/domains/cloud/gateway-usage-panel");
const { DropdownMenu, DropdownMenuContent } = await import("../src/components/ui/dropdown-menu");
const { MemoryRouter } = await import("react-router");
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
    {approvalNotices ? <GatewayUsageApprovalNotice /> : null}
    {notice && current.data ? <GatewayUsageNotice state={notice} status={current.data} stale={current.query.isError} /> : null}
    {hasError && !handled ? <p>Provider error</p> : null}
  </div>;
}
function OwnPanelProbe() { useGatewayUsage(true); return null; }
function shell(node: ReactNode) {
  return <MemoryRouter><QueryClientProvider client={getReactQueryClient()}>{node}</QueryClientProvider></MemoryRouter>;
}
function renderProbe() {
  root?.render(shell(<>{ownPanelActive ? <OwnPanelProbe /> : null}{Array.from({ length: paneCount }, (_, index) => <Probe key={index} />)}</>));
}
function button(label: string, scope: ParentNode = document) {
  return [...scope.querySelectorAll("button")].find((item) => item.textContent === label || item.getAttribute("aria-label") === label);
}
async function typeReason(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); }
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

test("Settings Usage shows percent left, reset and money per period, with More usage and collapsed technical details", async () => {
  const first = status.buckets[0];
  status = { ...status, state: "within_limit", buckets: [
    { ...first, usedMicroUsd: 400_000, remainingMicroUsd: 600_000, resetAt: "2099-01-01T05:00:00.000Z", canRequestReset: false },
    { ...first, id: "month", timeframe: "month", baseAllowanceMicroUsd: 4_000_000, allowanceMicroUsd: 4_000_000, usedMicroUsd: 3_000_000, remainingMicroUsd: 1_000_000, resetAt: "2099-01-31T05:00:00.000Z", canRequestReset: false },
    { ...first, id: "week", timeframe: "week", allowRequestReset: false, usedMicroUsd: 0, remainingMicroUsd: 1_000_000, resetAt: "2099-01-05T05:00:00.000Z", canRequestReset: false },
  ] };
  await act(async () => root?.render(shell(<GatewayUsageSettingsView onOpenAccount={() => {}} />)));
  await flush();
  const text = container.textContent ?? "";
  for (const value of ["Your limits", "Set by your organization", "Today", "60% left", "$0.60 of $1.00 left", "This month", "25% left", "$1.00 of $4.00 left", "This week", "100% left", "More usage", "You can ask once it runs out", "Technical details"]) expect(text).toContain(value);
  expect(container.querySelectorAll('[aria-label$=" increase"]')).toHaveLength(2);
  expect(container.querySelector('[aria-label="This week increase"]')).toBeNull();
  expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("60");
  expect(container.querySelector<HTMLDetailsElement>('[data-testid="gateway-usage-technical-details"]')?.open).toBe(false);
  for (const hidden of ["Base", "Extension", "Exhausted", "Hard limit", "GMT", "Refresh usage"]) expect(text).not.toContain(hidden);
});

test.each([
  { name: "settled writes with an unknown earlier period", coverage: trackedCoverage(), shown: ["Counting since", "Spend before that", "Not counted", "Last updated", "Chats still running"], hidden: ["Requests without a price yet", "Waiting to be counted", "request_settled"] },
  { name: "tracking not started", coverage: trackedCoverage({ historicalUnknownReason: "tracking_not_started", trackingStartedAt: null, pendingRequests: null, settlementReady: false, lastSettlementAt: null, lastSettlementRequestId: null }), shown: ["Spend before that", "Chats still running"], hidden: ["Counting since", "Last updated"] },
  { name: "separate pending, unpriced and incomplete counts", coverage: trackedCoverage({ pendingRequests: 2, settlementReady: false, unpricedRequests: 3, incompleteRequests: 4 }), shown: ["Waiting to be counted2", "Requests without a price yet3", "Requests still being counted4"], hidden: ["counted9", "yet9"] },
  { name: "legacy zero counts", coverage: { complete: false, unpricedRequests: 0 }, shown: ["Chats still running"], hidden: ["Requests without a price yet", "Counting since"] },
])("technical details distinguish $name", async ({ coverage, shown, hidden }) => {
  status = usageStatus({ state: "unlimited", buckets: [], coverage });
  await act(async () => root?.render(shell(<GatewayUsageSettingsView onOpenAccount={() => {}} />)));
  await flush();
  const details = container.querySelector('[data-testid="gateway-usage-technical-details"]')?.textContent ?? "";
  for (const text of shown) expect(details).toContain(text);
  for (const text of hidden) expect(details).not.toContain(text);
  expect(container.textContent).toContain("No limit");
  expect(container.textContent).not.toContain("More usage");
});

test("blocked card names the limit and reset in one line, stale truth disables only the ask, and warn-only says keep working", async () => {
  await act(async () => root?.render(shell(<GatewayUsageNotice state="blocked" status={status} stale={true} />)));
  const notice = container.querySelector('[data-testid="gateway-usage-notice"]');
  expect(notice?.querySelector("h2")?.textContent).toBe("You’ve used today’s $1.00");
  expect(notice?.textContent).toContain("Couldn’t refresh, showing the last known limit");
  expect(notice?.querySelector("svg")?.classList.contains("lucide-lock-keyhole")).toBe(true);
  for (const old of ["Out of usage", "Consumed Limit", "Standard", "View Usage Limits"]) expect(notice?.textContent).not.toContain(old);
  expect(button("Ask for $0.25 more")?.disabled).toBe(true);
  expect(button("See usage")?.disabled).toBe(false);
  await act(async () => root?.render(shell(<GatewayUsageNotice state="blocked" status={status} stale={false} />)));
  expect(notice?.querySelector("time")?.getAttribute("title")).not.toBeNull();
  await act(async () => root?.render(shell(<GatewayUsageNotice state="blocked" status={{ ...status, buckets: status.buckets.map((bucket) => ({ ...bucket, allowRequestReset: false, canRequestReset: false })) }} stale={false} />)));
  expect(container.textContent).toContain("An admin can raise it.");
  expect(button("Ask for $0.25 more")).toBeUndefined();
  await act(async () => root?.render(shell(<GatewayUsageNotice state="over_limit" status={{ ...status, state: "over_limit", buckets: status.buckets.map((bucket) => ({ ...bucket, hardLimit: false })) }} stale={false} />)));
  expect(container.querySelector("h2")?.textContent).toBe("$0.30 over today’s $1.00");
  expect(container.textContent).toContain("You can keep working");
});

test("reason form rejects blank and submits trimmed input", async () => {
  const reasons: string[] = [];
  await act(async () => root?.render(<GatewayIncreaseForm pending={false} error={false} onSubmit={(reason) => reasons.push(reason)} />));
  const submit = button("Send request");
  const textarea = container.querySelector("textarea");
  const form = container.querySelector("form");
  if (!submit || !textarea || !form) throw new Error("Missing form controls");
  expect(submit.disabled).toBe(true);
  expect(textarea.required).toBe(true);
  expect(container.querySelector("label")?.htmlFor).toBe(textarea.id);
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(reasons).toHaveLength(0);
  await typeReason(textarea, " Finish task ");
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(reasons).toEqual(["Finish task"]);
});

test("Settings Usage has a layout-matching loading state, a no-false-unlimited error and a signed-out door", async () => {
  let resolveRead: ((value: Response) => void) | undefined;
  pendingRead = new Promise((resolve) => { resolveRead = resolve; });
  await act(async () => root?.render(shell(<GatewayUsageSettingsView onOpenAccount={() => {}} />)));
  expect(container.querySelector('[aria-label="Loading usage limits"]')).not.toBeNull();
  await act(async () => resolveRead?.(Response.json({ error: "unavailable" }, { status: 503 })));
  await flush();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("This doesn’t mean you have no limit.");
  pendingRead = undefined;
  await act(async () => button("Try again")?.click());
  await flush();
  expect(container.textContent).toContain("Your limits");
  let opened = 0;
  await act(async () => { signedIn = false; changeSettings("org_test", ""); root?.render(shell(<GatewayUsageSettingsView onOpenAccount={() => { opened++; }} />)); });
  expect(container.textContent).toContain("Sign in to OpenWork Cloud to see your usage limits.");
  await act(async () => button("Open Account")?.click());
  expect(opened).toBe(1);
});

test("the account menu shows percent left per limit and never schedules polling; opening Settings fetches fresh data", async () => {
  const interval = spyOn(globalThis, "setInterval");
  const first = status.buckets[0];
  status = usageStatus({ state: "within_limit", buckets: [
    { ...first, usedMicroUsd: 400_000, remainingMicroUsd: 600_000, resetAt: "2099-01-01T05:00:00.000Z" },
    { ...first, id: "month", timeframe: "month", usedMicroUsd: 620_000, remainingMicroUsd: 380_000, resetAt: "2099-01-31T05:00:00.000Z" },
  ] });
  try {
    await act(async () => root?.render(shell(<DropdownMenu open><DropdownMenuContent><GatewayUsageMenuItem /></DropdownMenuContent></DropdownMenu>)));
    await flush();
    const item = document.querySelector('[data-testid="gateway-usage-menu-item"]');
    expect(item?.textContent).toBe("UsageToday60% leftThis month38% left");
    expect(reads).toBe(1);
    await act(async () => root?.render(shell(<GatewayUsageSettingsView onOpenAccount={() => {}} />)));
    await flush();
    expect(reads).toBe(2);
    for (const state of ["blocked", "over_limit", "within_limit"] satisfies Array<typeof status.state>) {
      status = { ...status, state, buckets: status.buckets.map((bucket) => ({ ...bucket, resetRequestStatus: "pending" })) };
      await act(async () => { await refreshGatewayUsageAfterCloudSync(readGatewayUsageScope()); });
      await flush();
    }
    expect(interval.mock.calls.some((call) => call[1] === 30_000)).toBe(false);
    status = usageStatus({ state: "unlimited", buckets: [] });
    await act(async () => root?.render(shell(<DropdownMenu open><DropdownMenuContent><GatewayUsageMenuItem /></DropdownMenuContent></DropdownMenu>)));
    await act(async () => { await refreshGatewayUsageAfterCloudSync(readGatewayUsageScope()); });
    await flush();
    expect(document.querySelector('[data-testid="gateway-usage-menu-item"]')?.textContent).toBe("UsageNo limit");
  } finally { interval.mockRestore(); }
});

test("Settings More usage asks inline for the exact increase and pending status replaces the action", async () => {
  await act(async () => root?.render(shell(<GatewayUsageSettingsView onOpenAccount={() => {}} />)));
  await flush();
  expect(container.textContent).toContain("0% left");
  expect(container.textContent).toContain("Used up.");
  await act(async () => button("Ask for $0.25 more")?.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("Missing reason field");
  expect(container.textContent).toContain("What do you need it for?");
  await typeReason(textarea, " Finish task ");
  await act(async () => button("Send request")?.click());
  await flush();
  expect(writes).toBe(1);
  expect(submitted).toEqual({ bucketId: "bucket_test", reason: "Finish task" });
  expect(container.textContent).toContain("Asked for $0.25 more, waiting for an admin");
  expect(button("Ask for $0.25 more")).toBeUndefined();
  expect(container.querySelector("textarea")).toBeNull();
});

test("the chat card opens the reason field in place, submits once and turns into waiting", async () => {
  await act(async () => renderProbe());
  await flush();
  const ask = button("Ask for $0.25 more");
  if (!ask) throw new Error("Missing direct increase action");
  await act(async () => ask.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const notice = container.querySelector('[data-testid="gateway-usage-notice"]');
  expect(notice?.querySelector("h2")?.textContent).toBe("Ask for $0.25 more today");
  const textarea = notice?.querySelector("textarea");
  const submit = button("Send request");
  if (!textarea || !submit) throw new Error("Missing inline form");
  expect(submit.disabled).toBe(true);
  await typeReason(textarea, " Finish task ");
  await act(async () => submit.click());
  await flush();
  expect(writes).toBe(1);
  expect(submitted).toEqual({ bucketId: "bucket_test", reason: "Finish task" });
  expect(container.querySelector('[data-testid="gateway-usage-notice"] h2')?.textContent).toBe("Asked for $0.25 more today");
  expect(container.textContent).toContain("Waiting for an admin");
  expect(button("Ask for $0.25 more")).toBeUndefined();
  expect(container.querySelector("textarea")).toBeNull();
});

test("Cloud sync refresh discovers approval across closed non-Gateway session panes with one neutral card each", async () => {
  expect(isServer).toBe(false);
  enabled = false;
  approvalNotices = true;
  paneCount = 2;
  status = { ...status, state: "within_limit", buckets: status.buckets.map((bucket) => ({ ...bucket, usedMicroUsd: 800_000, remainingMicroUsd: 200_000, resetAt: "2099-01-01T05:00:00.000Z", resetRequestStatus: "pending", canRequestReset: false })) };
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
  for (const notice of notices) {
    expect(notice.parentElement?.getAttribute("role")).toBe("status");
    expect(notice.classList.contains("bg-green-3")).toBe(false);
    expect(notice.querySelector("h2")?.textContent).toBe("You got $0.25 more today");
    expect(notice.textContent).toMatch(/^.*\$1\.25 for today, resets /);
    expect(notice.querySelector("svg")?.classList.contains("text-green-11")).toBe(true);
    expect(notice.querySelectorAll("button")).toHaveLength(1);
  }
  expect(container.querySelector('[data-testid="gateway-usage-notice"]')).toBeNull();
});

test("approval dismiss hides every session, survives rehydration, and leaves future approvals visible", async () => {
  enabled = false;
  approvalNotices = true;
  paneCount = 2;
  status = approvedUsageStatus();
  status.buckets[0].resetAt = "2099-01-01T05:00:00.000Z";
  await act(async () => renderProbe());
  await flush();
  const notices = () => container.querySelectorAll('[data-testid="gateway-usage-approved-notice"]');
  expect(notices()).toHaveLength(2);
  const dismiss = button("Dismiss usage increase approval");
  if (!dismiss) throw new Error("Missing dismissal control");
  expect(dismiss.textContent).toBe("Dismiss");
  await act(async () => dismiss.click());
  expect(notices()).toHaveLength(0);
  expect(writes).toBe(0);
  expect(latest().data?.buckets[0].resetRequestStatus).toBe("approved");
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
  status = { ...status, buckets: [first, { ...first, id: "another-bucket", timeframe: "month" }] };
  await act(async () => { await latest().query.refetch(); });
  await flush();
  expect(notices()).toHaveLength(2);
  expect(notices()[0].querySelector("h2")?.textContent).toBe("You got $0.25 more this month");
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
  const dismiss = button("Dismiss usage increase approval");
  if (!dismiss) throw new Error("Missing dismissal control");
  await act(async () => dismiss.click());
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
  const dismiss = button("Dismiss usage increase approval");
  if (!dismiss) throw new Error("Missing dismissal control");
  const originalSetItem = localStorage.setItem;
  localStorage.setItem = () => { throw new Error("Storage full"); };
  try {
    await act(async () => dismiss.click());
    expect(container.querySelectorAll('[data-testid="gateway-usage-approved-notice"]')).toHaveLength(0);
  } finally {
    localStorage.setItem = originalSetItem;
  }
});

test("approval notice rejects stale, expired, zero-extension, switched-org and signed-out truth", async () => {
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
  readFailure = false;
  const approvedBucket = status.buckets[0];
  for (const bucket of [{ ...approvedBucket, extensionMicroUsd: 0 }, { ...approvedBucket, resetAt: "2020-01-01T05:00:00.000Z" }, { ...approvedBucket, resetRequestStatus: "denied" } satisfies typeof approvedBucket]) {
    status = { ...status, buckets: [bucket] };
    await act(async () => { await latest().query.refetch(); });
    await flush();
    expect(container.querySelector('[data-testid="gateway-usage-approved-notice"]')).toBeNull();
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

test("approved extension remains exhausted but cannot request another reset", async () => {
  const eligible = usageStatus().buckets[0];
  expect(eligible.extensionMicroUsd).toBe(0);
  expect(eligible.allowanceMicroUsd).toBe(eligible.baseAllowanceMicroUsd);
  expect(eligible.remainingMicroUsd).toBe(eligible.allowanceMicroUsd - eligible.usedMicroUsd);
  expect(eligible.canRequestReset).toBe(true);
  expect(eligible.resetRequestStatus).toBeNull();
  status = approvedUsageStatus();
  const approved = status.buckets[0];
  expect(approved).toMatchObject({
    baseAllowanceMicroUsd: 1_000_000, extensionMicroUsd: 250_000, allowanceMicroUsd: 1_250_000,
    usedMicroUsd: 1_300_000, remainingMicroUsd: -50_000,
    canRequestReset: false, resetRequestStatus: "approved",
  });
  expect(approved.remainingMicroUsd).toBe(approved.allowanceMicroUsd - approved.usedMicroUsd);
  await act(async () => root?.render(shell(<GatewayUsageSettingsView onOpenAccount={() => {}} />)));
  await flush();
  expect(container.textContent).toContain("Added $0.25");
  expect(container.textContent).toContain("$0.00 of $1.25 left");
  expect(button("Ask for $0.25 more")).toBeUndefined();
  await act(async () => renderProbe());
  await flush();
  await act(async () => {
    await expect(latest().reset.mutateAsync({ bucketId: approved.id, reason: "Another extension" })).rejects.toThrow("eligibility");
  });
  await flush();
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
  expect(container.textContent).toContain("You’ve used today’s $1.00");
  expect(container.textContent).not.toContain("Provider error");
  status = usageStatus({ state: "within_limit", buckets: [] });
  await act(async () => { await latest().query.refetch(); });
  await flush();
  expect(container.textContent).not.toContain("You’ve used today’s $1.00");
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
  expect(container.textContent).toContain("You’ve used today’s $1.00");
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
  expect(container.textContent).toContain("You’ve used today’s $1.00");
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
  expect(container.textContent).toContain("You can keep working");
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
    expect(container.textContent).toContain("You can keep working");
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
