import { afterAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { GatewayUsageLimitPolicy, GatewayUsageResetPage, GatewayUsageResetRequest, GatewayUsageStatus } from "@openwork/types/den/gateway-usage-limits";
import type { DenOrgMember, DenOrgTeam } from "../app/(den)/_lib/den-org";

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(() => GlobalRegistrator.unregister());
const { act } = await import("react");
const { DenCombobox } = await import("../app/(den)/_components/ui/combobox");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const requests = await import("../app/(den)/_lib/den-flow");
const navigation = await import("next/navigation");
const pushed: string[] = [];
const replaced: string[] = [];
let searchParams = new URLSearchParams();
const router = { push: (href: string) => { pushed.push(href); }, replace: (href: string) => { replaced.push(href); }, back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {} };
spyOn(navigation, "useRouter").mockImplementation(() => router);
spyOn(navigation, "useSearchParams").mockImplementation(() => new navigation.ReadonlyURLSearchParams(searchParams));
const { GatewayUsageLimitsSection, GatewayMemberUsageDetails } = await import("../app/(den)/dashboard/_components/gateway-usage-limits-section");
const { GatewayLimitEditor } = await import("../app/(den)/dashboard/_components/gateway-limit-editor-screen");
const { GatewayPerson } = await import("../app/(den)/dashboard/_components/gateway-person-screen");
const { getAiGatewayLimitRoute, getAiGatewayLimitsRoute, getAiGatewayPersonRoute, getNewAiGatewayLimitRoute } = await import("../app/(den)/_lib/den-org");
const { GatewayUsageResetRequests } = await import("../app/(den)/dashboard/_components/gateway-usage-reset-requests");
const { gatewayLimitsKey, mutateGatewayLimits, formatLimitMoney, microUsdDecimal, newGatewayPolicy, useGatewayLimitsMutation } = await import("../app/(den)/dashboard/_components/gateway-usage-limits-data");
const { gatewayUsagePolicyWriteSchema, gatewayUsdToMicroUsd, MAX_GATEWAY_ALLOWANCE_MICRO_USD } = await import("@openwork/types/den/gateway-usage-limits");

const orgId = "org-fixture";
const person = { id: "member-fixture", name: "Example Member", email: "member@example.test" };
const team: DenOrgTeam = { id: "team-fixture", name: "Example Team", memberIds: [person.id], createdAt: null, updatedAt: null, managedByScim: false, grantsOrganizationAdmin: false };
const member: DenOrgMember = { id: person.id, userId: "user-fixture", inviteId: null, role: "member", effectiveRole: "member", adminTeams: [], createdAt: null, joinedAt: null, isOwner: false, user: { id: "user-fixture", name: person.name, email: person.email, image: null } };
const policiesPath = "/v1/gateway/usage-limit-policies";
const resetsPath = "/v1/gateway/usage-limit-reset-requests";
const membersPath = "/v1/gateway/usage-limits/members";

function policy(): GatewayUsageLimitPolicy {
  return { id: "policy-fixture", name: "Standard", revision: 7, hardLimit: true, allowRequestReset: true, limits: [{ timeframe: "month", costLimitMicroUsd: 100_000_001 }], assignments: [] };
}
function status(): GatewayUsageStatus {
  return { organizationId: orgId, memberId: person.id, serverTime: "2026-01-15T05:00:00.000Z", state: "blocked", coverage: { complete: false, unpricedRequests: 2 }, buckets: [{ id: "bucket-fixture", timeframe: "month", policyId: "policy-fixture", policyName: "Standard", baseAllowanceMicroUsd: 100_000_000, allowanceMicroUsd: 125_000_000, extensionMicroUsd: 25_000_000, usedMicroUsd: 130_000_001, remainingMicroUsd: -5_000_001, resetAt: "2099-02-01T05:00:00.000Z", hardLimit: true, allowRequestReset: true, canRequestReset: false, resetRequestStatus: "approved" }] };
}
function trackedCoverage(overrides: Partial<GatewayUsageStatus["coverage"]> = {}): GatewayUsageStatus["coverage"] {
  return {
    complete: false, unpricedRequests: 0, incompleteRequests: 0,
    historicalCoverage: "unknown", historicalUnknownReason: "period_predates_tracking",
    trackingStartedAt: "2026-01-15T05:00:00.000Z", pendingRequests: 0, settlementReady: true,
    lastSettlementAt: "2026-01-15T05:01:00.000Z", lastSettlementRequestId: "request_settled",
    ...overrides,
  };
}
function reset(): GatewayUsageResetRequest {
  return { id: "reset-fixture", memberId: person.id, memberName: person.name, memberEmail: person.email, bucketId: "bucket-fixture", timeframe: "month", policyName: "Standard", reason: "Need more estimated usage for a review. <script>untrusted</script>", status: "pending", createdAt: "2026-01-15T05:00:00.000Z", reviewedBy: null, reviewedAt: null, baseAllowanceMicroUsd: 100_000_001, allowanceMicroUsd: 100_000_001, usedMicroUsd: 130_000_000, resetAt: "2099-02-01T05:00:00.000Z" };
}

function resetPage(view: GatewayUsageResetPage["view"], rows: GatewayUsageResetRequest[], pendingCount: number, nextCursor: string | null = null): GatewayUsageResetPage {
  return { requests: rows, view, limit: 50, pendingCount, hasMore: nextCursor !== null, nextCursor };
}
function resetListReply(path: string, rows: GatewayUsageResetRequest[]) {
  if (path === policiesPath) return { payload: { policies: [policy()] } };
  const params = new URLSearchParams(path.split("?")[1]);
  const view = params.get("view") === "history" ? "history" : "pending";
  const limit = Number(params.get("limit"));
  const pendingCount = rows.filter((row) => row.status === "pending").length;
  const filtered = rows.filter((row) => view === "pending" ? row.status === "pending" : row.status !== "pending");
  return { payload: { ...resetPage(view, filtered.slice(0, limit), pendingCount, filtered.length > limit ? "next-page" : null), limit } };
}

type Call = { path: string; init: RequestInit };
type Reply = { payload: unknown; status?: number };
type Handler = (call: Call) => Reply | Promise<Reply>;
function defaultReply({ path }: Call): Reply {
  if (path === policiesPath) return { payload: { policies: [policy()] } };
  if (path.startsWith(`${resetsPath}?`)) return resetListReply(path, [reset()]);
  if (path.startsWith(`${membersPath}?`)) return { payload: { members: [person] } };
  if (path === `${membersPath}/${person.id}`) return { payload: status() };
  if (path.endsWith("/assignments")) return { payload: { assignments: [] } };
  if (path.startsWith("/v1/inference-providers/usage")) return { status: 503, payload: { error: "unavailable", message: "Usage unavailable" } };
  throw new Error(`Unexpected request ${path}`);
}
const tick = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); };
async function mount(node: ReactNode, handler: Handler = defaultReply) {
  const calls: Call[] = [];
  const request = spyOn(requests, "requestJson").mockImplementation(async (path, init = {}) => {
    const call = { path, init };
    calls.push(call);
    const reply = await handler(call);
    return { payload: reply.payload, response: Response.json(reply.payload, { status: reply.status ?? 200 }), text: JSON.stringify(reply.payload) };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  await tick();
  return { calls, client, container, async rerender(next: ReactNode) { await act(async () => root.render(<QueryClientProvider client={client}>{next}</QueryClientProvider>)); await tick(); }, async close() { await act(async () => root.unmount()); client.clear(); request.mockRestore(); container.remove(); } };
}
function button(label: string, scope: ParentNode = document.body) {
  const element = [...scope.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label);
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}
async function click(label: string, scope?: ParentNode) {
  await act(async () => button(label, scope).click());
  await tick();
}
async function toggleHistory(scope: ParentNode = document.body) {
  const summary = [...scope.querySelectorAll("summary")].find((element) => element.textContent === "Previous requests");
  if (!summary) throw new Error("Missing previous requests disclosure");
  await act(async () => summary.click());
  await tick();
}
async function fill(selector: string, value: string) {
  const input = document.querySelector(selector);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input ${selector}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await tick();
}
async function choose(label: string, option: string) {
  const input = document.querySelector(`[role="combobox"][aria-label="${label}"]`);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing combobox ${label}`);
  await act(async () => { input.focus(); input.click(); });
  await tick();
  const item = [...document.querySelectorAll('[role="option"]')].find((element) => element.textContent?.includes(option));
  if (!(item instanceof HTMLElement)) throw new Error(`Missing option ${option}`);
  await act(async () => { item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); item.click(); });
  await tick();
}
function expectField(scope: ParentNode, label: string, value: string) {
  const term = [...scope.querySelectorAll("dt")].find((element) => element.textContent === label);
  expect(term?.nextElementSibling?.tagName).toBe("DD");
  expect(term?.nextElementSibling?.textContent).toBe(value);
}
const orgSlug = "fixture";
const section = () => <GatewayUsageLimitsSection orgId={orgId} orgSlug={orgSlug} teams={[team]} members={[member]} />;
const editor = (props: { policyId?: string; target?: { memberId: string } | { teamId: string } } = {}) => <GatewayLimitEditor orgId={orgId} orgSlug={orgSlug} teams={[team]} members={[member]} {...props} />;
const personPage = () => <GatewayPerson orgId={orgId} orgSlug={orgSlug} member={member} teams={[team]} />;
async function press(selector: string) {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
  await act(async () => element.click());
  await tick();
}
function postBodies(calls: Call[]) {
  return calls.filter((call) => call.init.method === "POST").map((call) => ({ path: call.path, body: JSON.parse(String(call.init.body)) }));
}

test("shared validation defaults, unique frames, exact precision, zero and overflow", () => {
  expect(newGatewayPolicy()).toEqual({ name: "", hardLimit: true, allowRequestReset: true, limits: [{ timeframe: "month", costUsd: "" }] });
  const body = { ...newGatewayPolicy(), name: "Valid", limits: [{ timeframe: "month", costUsd: "0.000001" }] };
  expect(gatewayUsagePolicyWriteSchema.parse(body).limits[0].costUsd).toBe("0.000001");
  for (const value of ["-1", "NaN", "Infinity", "1e3", "0.0000001", "", "9007199254740992"]) {
    expect(gatewayUsagePolicyWriteSchema.safeParse({ ...body, limits: [{ timeframe: "month", costUsd: value }] }).success).toBe(false);
  }
  expect(gatewayUsagePolicyWriteSchema.safeParse({ ...body, limits: [...body.limits, ...body.limits] }).success).toBe(false);
  expect(gatewayUsdToMicroUsd("0")).toBe(0);
  expect(gatewayUsdToMicroUsd(microUsdDecimal(MAX_GATEWAY_ALLOWANCE_MICRO_USD))).toBe(MAX_GATEWAY_ALLOWANCE_MICRO_USD);
  expect(formatLimitMoney(100_000_001)).toBe("$100.000001");
  expect(formatLimitMoney(1)).toBe("$0.000001");
});

test("new limit validates amounts and who before creating the policy and applying it", async () => {
  pushed.length = 0;
  const view = await mount(editor({ target: { memberId: person.id } }), (call) => call.init.method === "POST" ? { payload: policy() } : defaultReply(call));
  try {
    expect(document.querySelector('[aria-label="Limit per month"]')?.getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('[aria-label="Limit per day"]')?.getAttribute("aria-checked")).toBe("false");
    expect(document.querySelector('[aria-label="Let them ask for 25% more"]')?.getAttribute("aria-checked")).toBe("true");
    expect(view.container.textContent).toContain("Example Member");
    expect(view.container.textContent).toContain("Resets on the 1st");
    expect(view.container.querySelector('[aria-label="Amount a day"]')).toBeNull();
    await fill('[aria-label="Amount a month"]', "0.0000001");
    await click("Save limit");
    expect(view.container.textContent).toContain("Enter an amount like 20 or 12.50.");
    expect(view.calls.some((call) => call.init.method === "POST")).toBe(false);
    await fill('[aria-label="Amount a month"]', "1.000001");
    expect(view.container.textContent).not.toContain("Enter an amount like 20 or 12.50.");
    await click("Remove");
    await click("Save limit");
    expect(view.container.textContent).toContain("Choose who this limit applies to.");
    expect(view.calls.some((call) => call.init.method === "POST")).toBe(false);
    await click("Everyone in the organization");
    await click("Everyone in the organization");
    await press('[data-testid="gateway-limit-add-person"]');
    await choose("Person", "Example Member");
    await click("Limit per day");
    expect(view.container.querySelector('[data-testid="gateway-limit-period-day"]')?.textContent).toContain("Resets every day at 5:00");
    await fill('[aria-label="Amount a day"]', "0");
    await press('[data-testid="gateway-limit-soft"]');
    await click("Let them ask for 25% more");
    await click("Save limit");
    expect(postBodies(view.calls)).toEqual([
      { path: policiesPath, body: { name: "Example Member", hardLimit: false, allowRequestReset: false, limits: [{ timeframe: "day", costUsd: "0" }, { timeframe: "month", costUsd: "1.000001" }] } },
      { path: `${policiesPath}/policy-fixture/assignments`, body: { memberId: person.id } },
    ]);
    expect(pushed.at(-1)).toBe(getAiGatewayLimitsRoute(orgSlug));
  } finally { await view.close(); }
});

test("edit retains revision and blocks after a 409 without discarding local edits", async () => {
  let current = policy();
  const view = await mount(editor({ policyId: current.id }), (call) => {
    if (call.path === policiesPath) return { payload: { policies: [current] } };
    if (call.init.method === "PATCH") {
      current = { ...current, name: "Changed remotely", revision: 8 };
      return { status: 409, payload: { error: "revision_conflict", message: "Revision is stale." } };
    }
    return defaultReply(call);
  });
  try {
    expect(document.querySelector<HTMLInputElement>('[aria-label="Amount a month"]')?.value).toBe("100.000001");
    await fill('[aria-label="Amount a month"]', "150");
    await click("Save changes");
    const write = view.calls.find((call) => call.init.method === "PATCH");
    expect(write?.path).toBe(`${policiesPath}/policy-fixture`);
    expect(JSON.parse(String(write?.init.body))).toMatchObject({ revision: 7, limits: [{ timeframe: "month", costUsd: "150" }] });
    expect(document.body.textContent).toContain("This policy or request has changed");
    expect(document.body.textContent).toContain("changed or was deleted somewhere else");
    expect(document.querySelector<HTMLInputElement>('[aria-label="Amount a month"]')?.value).toBe("150");
    expect(button("Save changes").disabled).toBe(true);
    expect(view.calls.filter((call) => call.init.method === "PATCH")).toHaveLength(1);
  } finally { await view.close(); }
});

test("delete archives the displayed revision without a confirm and returns to Limits", async () => {
  pushed.length = 0;
  const view = await mount(editor({ policyId: "policy-fixture" }), (call) => {
    if (call.init.method === "POST") return { payload: { ...policy(), revision: 8, archivedAt: "2026-01-20T00:00:00.000Z" } };
    return defaultReply(call);
  });
  try {
    await press('[data-testid="gateway-limit-delete"]');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(postBodies(view.calls)).toEqual([{ path: `${policiesPath}/policy-fixture/archive`, body: { revision: 7 } }]);
    expect(pushed.at(-1)).toBe(getAiGatewayLimitsRoute(orgSlug, "policy-fixture"));
  } finally { await view.close(); }
});

test("a deleted limit can be restored from the Limits note", async () => {
  replaced.length = 0;
  searchParams = new URLSearchParams("tab=limits&deleted=policy-fixture");
  let archived = true;
  const view = await mount(section(), (call) => {
    if (call.init.method === "POST") { archived = false; return { payload: { ...policy(), revision: 9 } }; }
    if (call.path === policiesPath) return { payload: { policies: [archived ? { ...policy(), revision: 8, archivedAt: "2026-01-20T00:00:00.000Z" } : { ...policy(), revision: 9 }] } };
    return defaultReply(call);
  });
  try {
    expect(view.container.textContent).toContain("Deleted Standard. It no longer applies to anyone.");
    expect(view.container.textContent).toContain("No spend limits yet");
    await press('[data-testid="gateway-limit-undo"]');
    expect(postBodies(view.calls)).toEqual([{ path: `${policiesPath}/policy-fixture/restore`, body: { revision: 8 } }]);
    expect(replaced.at(-1)).toBe(getAiGatewayLimitsRoute(orgSlug));
  } finally { searchParams = new URLSearchParams(); await view.close(); }
});

test("centralized assignment transport keeps membership, team and organization targets distinct", async () => {
  const view = await mount(section(), (call) => call.init.method === "POST" || call.init.method === "DELETE" ? { payload: policy() } : defaultReply(call));
  try {
    const targets: ({ memberId: string } | { teamId: string } | { organization: true })[] = [{ memberId: person.id }, { teamId: team.id }, { organization: true }];
    for (const target of targets) await mutateGatewayLimits(orgId, { type: "assign", policyId: "policy/id", target });
    await mutateGatewayLimits(orgId, { type: "unassign", policyId: "policy/id", assignmentId: "assignment/id" });
    const writes = view.calls.filter((call) => call.init.method !== "GET");
    expect(writes.slice(0, 3).map((call) => JSON.parse(String(call.init.body)))).toEqual(targets);
    for (const call of writes.slice(0, 3)) expect(call.path).toBe(`${policiesPath}/policy%2Fid/assignments`);
    expect(writes[3]).toMatchObject({ path: `${policiesPath}/policy%2Fid/assignments/assignment%2Fid`, init: { method: "DELETE" } });
    const { ORG_SCOPE_HEADER } = await import("../app/(den)/_lib/org-scope");
    for (const call of writes) expect(new Headers(call.init.headers).get(ORG_SCOPE_HEADER)).toBe(orgId);
    expect(view.container.querySelector('[aria-label="Assignments for Standard"]')).toBeNull();
  } finally { await view.close(); }
});

test("a person's page distinguishes limit failures, mismatches and no limit without stale success", async () => {
  let state: "unlimited" | "error" | "invalid" = "error";
  const view = await mount(personPage(), (call) => {
    if (call.path === `${membersPath}/${person.id}`) {
      if (state === "error") return { status: 503, payload: { error: "unavailable", message: "Accounting unavailable" } };
      if (state === "invalid") return { payload: { ...status(), memberId: "someone-else" } };
      return { payload: { ...status(), state: "unlimited", buckets: [] } };
    }
    return defaultReply(call);
  });
  try {
    expect(view.container.textContent).toContain("Accounting unavailable");
    expect(view.container.textContent).not.toContain("No limit");
    state = "invalid";
    await click("Retry spend limit");
    expect(view.container.textContent).toContain("different member or organization");
    expect(view.container.textContent).not.toContain("$125");
    state = "unlimited";
    await click("Retry spend limit");
    expect(view.container.textContent).toContain("No limit");
    expect(view.container.querySelector('[data-testid="gateway-person-set-limit"]')?.getAttribute("href")).toBe(getNewAiGatewayLimitRoute(orgSlug, { memberId: person.id }));
    expect(view.container.textContent).toContain("Usage unavailable");
  } finally { await view.close(); }
});

test("effective usage shows estimates, overage, extension, reset state and direct/team/organization candidates", async () => {
  const direct = { ...policy(), id: "lower-policy", name: "Smaller direct policy", limits: [{ timeframe: "month", costLimitMicroUsd: 50_000_000 }], assignments: [{ id: "direct", memberId: person.id, teamId: null, organization: false }] } satisfies GatewayUsageLimitPolicy;
  const inherited = { ...policy(), assignments: [{ id: "team-assignment", memberId: null, teamId: team.id, organization: false }] };
  const everyone = { ...policy(), id: "org-policy", name: "Organization baseline", limits: [{ timeframe: "month", costLimitMicroUsd: 25_000_000 }], assignments: [{ id: "org-assignment", memberId: null, teamId: null, organization: true }] } satisfies GatewayUsageLimitPolicy;
  const view = await mount(<GatewayMemberUsageDetails status={status()} policies={[direct, inherited, everyone]} teams={[team]} />);
  try {
    expect(view.container.textContent).toContain("$130.000001 used");
    expectField(view.container, "Total", "$125.00");
    expect(view.container.textContent).toContain("$5.000001 over allowance");
    expectField(view.container, "Base", "$100.00");
    expectField(view.container, "Extension", "$25.00");
    expectField(view.container, "Increase requests", "Allowed");
    expectField(view.container, "Request status", "approved");
    expect(view.container.textContent).not.toContain("·");
    expect(view.container.querySelector("tbody tr")?.textContent).toContain("Standard - 1 month");
    expect([...view.container.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["Policy", "Usage"]);
    const blocked = [...view.container.querySelectorAll("span")].find((element) => element.textContent === "Blocked");
    expect(blocked?.classList.contains("bg-gray-100")).toBe(true);
    expect(blocked?.classList.contains("text-red-600")).toBe(false);
    expect(blocked?.querySelector('svg[aria-hidden="true"]')?.classList.contains("lucide-lock-keyhole")).toBe(true);
    expect(view.container.textContent).toContain("05:00");
    const summary = view.container.querySelector("summary");
    await act(async () => summary?.click());
    expect(view.container.querySelector("details")?.open).toBe(true);
    expect(view.container.textContent).toContain("Direct assignment");
    expect(view.container.textContent).toContain("Team: Example Team");
    expect(view.container.textContent).toContain("Organization baseline");
    expect(view.container.textContent).toContain("Everyone in the org");
    expect(view.container.textContent).toContain("Not selected");
    expect(view.container.textContent).toContain("highest allowance wins");
  } finally { await view.close(); }
});

test("limits are one flat row each with who, amounts, enforcement and an Edit page", async () => {
  pushed.length = 0;
  const assigned = { ...policy(), limits: [{ timeframe: "month" as const, costLimitMicroUsd: 300_000_000 }, { timeframe: "day" as const, costLimitMicroUsd: 20_000_000 }], assignments: [{ id: "team-assignment", memberId: null, teamId: team.id, organization: false }] };
  const view = await mount(section(), (call) => call.path === policiesPath ? { payload: { policies: [assigned, { ...policy(), id: "soft", name: "Soft", hardLimit: false }] } } : defaultReply(call));
  try {
    const rows = view.container.querySelectorAll('[data-testid="gateway-limit-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Example Team");
    expect(rows[0]?.textContent).toContain("$20.00 a day, $300.00 a month each");
    expect(rows[0]?.textContent).toContain("Pauses them");
    expect(rows[1]?.textContent).toContain("Not applied to anyone yet");
    expect(rows[1]?.textContent).toContain("Only warns");
    expect(rows[0]?.querySelector('a[aria-label="Edit Standard"]')?.getAttribute("href")).toBe(getAiGatewayLimitRoute(orgSlug, "policy-fixture"));
    expect(view.container.querySelector('[data-testid="gateway-limit-new"]')?.getAttribute("href")).toBe(getNewAiGatewayLimitRoute(orgSlug));
    expect(view.container.querySelector("table")).toBeNull();
    await choose("Find a person", "Example Member");
    expect(pushed.at(-1)).toBe(getAiGatewayPersonRoute(orgSlug, person.id));
  } finally { await view.close(); }
});

test("a person's page shows each limit period with its policy, usage and technical details", async () => {
  const view = await mount(personPage());
  try {
    const rows = view.container.querySelectorAll('[data-testid="gateway-person-limit-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("$125.00 a month");
    expect(rows[0]?.textContent).toContain("Standard · pauses at the limit");
    expect(rows[0]?.textContent).toContain("$130.000001 used");
    expect(rows[0]?.querySelector("a")?.getAttribute("href")).toBe(getAiGatewayLimitRoute(orgSlug, "policy-fixture"));
    expect(view.container.textContent).toContain("Paused");
    expect(view.container.querySelector("details")?.open).toBe(false);
    expect(view.container.textContent).toContain("Technical details");
  } finally { await view.close(); }
});

test("reset queue previews ceil(base/4), safely renders reasons, approves once and shows reviewer history", async () => {
  let current = reset();
  const view = await mount(<GatewayUsageResetRequests orgId={orgId} members={[member]} />, (call) => {
    if (call.init.method === "POST") { current = { ...current, status: "approved", reviewedBy: person.id, reviewedAt: "2026-01-16T05:00:00.000Z", allowanceMicroUsd: 125_000_002 }; return { payload: current }; }
    return resetListReply(call.path, [current]);
  });
  try {
    const impact = "+$25.000001 allowance ($125.000002 total); may increase provider charges; no undo.";
    expect(view.container.textContent).toContain(impact);
    expect(view.container.textContent).not.toContain("·");
    expect(view.container.textContent).toContain("Approval will still leave this bucket exhausted");
    expect(view.container.querySelector("script")).toBeNull();
    expect([...view.container.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["User", "Reason", "Requested", "Actions"]);
    const row = view.container.querySelector("tbody tr");
    expect(row?.textContent).toContain(person.name);
    expect(row?.textContent).toContain(reset().reason);
    expect(row?.querySelector("time")?.dateTime).toBe(reset().createdAt);
    expect(row?.querySelectorAll("button")).toHaveLength(2);
    expect(row?.textContent).not.toContain("Base:");
    expect(row?.nextElementSibling?.querySelector("td")?.colSpan).toBe(4);
    const context = row?.nextElementSibling;
    expect(context?.textContent).toContain("Standard - 1 month");
    expect(context?.textContent).toContain(impact);
    expect(context?.querySelector("time")?.dateTime).toBe(reset().resetAt);
    expect(context?.querySelector("time")?.textContent).toContain("05:00");
    const approval = button("Approve 25% for Example Member, 1 month");
    const description = document.getElementById(approval.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe(impact);
    expect(context?.contains(description)).toBe(true);
    expect(description?.parentElement?.classList.contains("text-[var(--ow-muted)]")).toBe(true);
    expect([...view.container.querySelectorAll("span")].filter((element) => element.textContent === impact)).toHaveLength(1);
    expect(row?.textContent).not.toContain("no undo");
    expect(view.container.textContent).not.toContain(reset().bucketId);
    expect(view.container.textContent).not.toContain(reset().id);
    expect(view.container.querySelector("summary")).toBeNull();
    await click("Approve 25% for Example Member, 1 month");
    expect(view.calls.find((call) => call.init.method === "POST")).toMatchObject({ path: `${resetsPath}/reset-fixture/approve`, init: { body: "{}" } });
    expect(view.container.textContent).toContain("No pending requests");
    await toggleHistory();
    expect(view.container.textContent).toContain("approved");
    expect(view.container.textContent).toContain("Reviewer: Example Member");
    expect(view.container.textContent).toContain("Jan 16, 2026");
    expect(view.container.textContent).not.toContain("no undo");
    expect(view.container.querySelector('#gateway-reset-history [aria-describedby]')).toBeNull();
  } finally { await view.close(); }
});

test("each approval describes only its own financial impact without adding a confirmation step", async () => {
  const second = { ...reset(), id: "second-request", memberName: "Second person", baseAllowanceMicroUsd: 8_000_000, allowanceMicroUsd: 8_000_000, usedMicroUsd: 9_000_000 };
  const view = await mount(<GatewayUsageResetRequests orgId={orgId} members={[]} />, (call) => resetListReply(call.path, [reset(), second]));
  try {
    const first = button("Approve 25% for Example Member, 1 month");
    const next = button("Approve 25% for Second person, 1 month");
    expect(first.getAttribute("aria-describedby")).not.toBe(next.getAttribute("aria-describedby"));
    expect(document.getElementById(first.getAttribute("aria-describedby") ?? "")?.textContent).toBe("+$25.000001 allowance ($125.000002 total); may increase provider charges; no undo.");
    expect(document.getElementById(next.getAttribute("aria-describedby") ?? "")?.textContent).toBe("+$2.00 allowance ($10.00 total); may increase provider charges; no undo.");
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(button("Deny request for Second person, 1 month").disabled).toBe(false);
    expect(view.calls.every((call) => call.init.method === "GET")).toBe(true);
  } finally { await view.close(); }
});

test("denial uses its own route; stale decisions are refreshed and never silently retried", async () => {
  let current = reset();
  const view = await mount(<GatewayUsageResetRequests orgId={orgId} members={[]} />, (call) => {
    if (call.init.method === "POST") { current = { ...current, status: "expired" }; return { status: 409, payload: { error: "stale_request", message: "The bucket changed." } }; }
    return resetListReply(call.path, [current]);
  });
  try {
    await click("Deny request for Example Member, 1 month");
    expect(view.calls.find((call) => call.init.method === "POST")).toMatchObject({ path: `${resetsPath}/reset-fixture/deny`, init: { body: "{}" } });
    expect(view.container.textContent).toContain("Refresh and review the latest state");
    expect(view.calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
    expect(view.container.textContent).toContain("No pending requests");
    await toggleHistory();
    expect(view.container.textContent).toContain("expired");
  } finally { await view.close(); }
});

function MutationHarness() {
  const mutation = useGatewayLimitsMutation(orgId);
  return <button disabled={mutation.isPending} onClick={() => mutation.mutate({ type: "deny", requestId: "request/id" })}>Mutate</button>;
}
test("mutations invalidate every affected cache within only their organization and pin org headers", async () => {
  const view = await mount(<MutationHarness />, () => ({ payload: reset() }));
  try {
    for (const kind of ["policies", "assignments", "usage", "members", "reset-requests", "reset-history-available"]) {
      view.client.setQueryData([...gatewayLimitsKey(orgId), kind], { existing: true });
      view.client.setQueryData([...gatewayLimitsKey("other-org"), kind], { existing: true });
    }
    await click("Mutate");
    for (const kind of ["policies", "assignments", "usage", "members", "reset-requests", "reset-history-available"]) {
      expect(view.client.getQueryState([...gatewayLimitsKey(orgId), kind])?.isInvalidated).toBe(true);
      expect(view.client.getQueryState([...gatewayLimitsKey("other-org"), kind])?.isInvalidated).toBe(false);
    }
    expect(view.calls[0].path).toBe(`${resetsPath}/request%2Fid/deny`);
    const { ORG_SCOPE_HEADER } = await import("../app/(den)/_lib/org-scope");
    expect(new Headers(view.calls[0].init.headers).get(ORG_SCOPE_HEADER)).toBe(orgId);
  } finally { await view.close(); }
});

test("pending and failed policy reads do not masquerade as empty policy lists", async () => {
  let resolve: ((reply: Reply) => void) | undefined;
  const view = await mount(section(), (call) => call.path === policiesPath ? new Promise<Reply>((done) => { resolve = done; }) : defaultReply(call));
  try {
    expect(view.container.textContent).toContain("Loading limits");
    expect(view.container.textContent).not.toContain("No spend limits yet");
    await act(async () => resolve?.({ status: 403, payload: { error: "forbidden", message: "Only owners and admins can manage limits." } }));
    await tick();
    expect(view.container.textContent).toContain("Only owners and admins");
    expect(view.container.textContent).not.toContain("No spend limits yet");
  } finally { await view.close(); }
});

test("no active limits shows one New limit door and hides the queue and person lookup without private reads", async () => {
  for (const policies of [[], [{ ...policy(), archivedAt: "2026-01-20T00:00:00.000Z" }]]) {
    const view = await mount(<>{section()}<GatewayUsageResetRequests orgId={orgId} members={[member]} /></>, ({ path }) => {
      expect(path).toBe(policiesPath);
      return { payload: { policies } };
    });
    try {
      expect(view.container.textContent).toContain("No spend limits yet");
      expect(view.container.querySelectorAll('[data-testid="gateway-limit-new"]')).toHaveLength(1);
      expect(view.container.textContent).not.toContain("Limit increase requests");
      expect(view.container.querySelector('[aria-label="Find a person"]')).toBeNull();
      expect(view.calls.every((call) => call.path === policiesPath)).toBe(true);
    } finally { await view.close(); }
  }
});

test("history availability errors remain retryable without mounting paginated history", async () => {
  let malformed = true;
  const view = await mount(<GatewayUsageResetRequests orgId={orgId} members={[]} />, (call) => {
    if (call.path === `${resetsPath}?view=history&limit=1`) return malformed
      ? { payload: resetPage("history", [{ ...reset(), status: "denied" }], 0) }
      : resetListReply(call.path, [{ ...reset(), status: "denied" }]);
    return defaultReply(call);
  });
  try {
    expect(view.container.textContent).toContain("Could not check previous requests");
    expect(view.container.querySelector("summary")).toBeNull();
    expect(view.calls.some((call) => call.path === `${resetsPath}?view=history&limit=50`)).toBe(false);
    malformed = false;
    await click("Refresh requests");
    expect(view.container.textContent).not.toContain("Could not check previous requests");
    expect(view.container.querySelector("summary")?.textContent).toBe("Previous requests");
    expect(view.container.querySelector("details")?.open).toBe(false);
    await toggleHistory();
    expect(view.calls.at(-1)?.path).toBe(`${resetsPath}?view=history&limit=50`);
  } finally { await view.close(); }
});

test("writes use the shared schema rather than sending unsupported precision", async () => {
  const request = spyOn(requests, "requestJson");
  try {
    await expect(mutateGatewayLimits(orgId, { type: "save", body: { ...newGatewayPolicy(), name: "Invalid", limits: [{ timeframe: "day", costUsd: "0.0000001" }] } })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  } finally { request.mockRestore(); }
});

test("a team target is named and turning off every period blocks save", async () => {
  const view = await mount(editor({ target: { teamId: team.id } }));
  try {
    expect(view.container.textContent).toContain("Example Team");
    expect(view.container.textContent).toContain("1 members, future members included");
    await click("Limit per month");
    expect(view.container.querySelector('[aria-label="Amount a month"]')).toBeNull();
    await click("Save limit");
    expect(view.container.textContent).toContain("Turn on at least one period.");
    expect(view.calls.some((call) => call.init.method !== "GET")).toBe(false);
  } finally { await view.close(); }
});

test("unknown create outcome keeps the draft and blocks accidental resubmission", async () => {
  const view = await mount(editor({ target: { memberId: person.id } }), (call) => {
    if (call.init.method === "POST") throw new Error("Network disconnected");
    return defaultReply(call);
  });
  try {
    await fill('[aria-label="Amount a month"]', "25");
    await click("Save limit");
    expect(document.body.textContent).toContain("outcome could not be verified");
    expect(button("Save limit").disabled).toBe(true);
    await click("Save limit");
    expect(view.calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Amount a month"]')?.value).toBe("25");
  } finally { await view.close(); }
});

test("remote people failures remain retryable without a false empty state, then open the person's page", async () => {
  pushed.length = 0;
  let failPeople = true;
  const view = await mount(section(), (call) => {
    if (call.path.startsWith(`${membersPath}?`) && failPeople) return { status: 503, payload: { error: "unavailable", message: "People unavailable" } };
    return defaultReply(call);
  });
  try {
    const input = view.container.querySelector<HTMLInputElement>('[aria-label="Find a person"]');
    if (!input) throw new Error("Missing member search");
    await act(async () => { input.focus(); input.click(); });
    await tick();
    expect(view.container.textContent).toContain("People unavailable");
    expect(view.container.querySelector('[role="option"]')).toBeNull();
    expect(view.container.textContent).not.toContain("No people match");
    failPeople = false;
    await click("Retry people");
    await choose("Find a person", "Example Member");
    expect(pushed.at(-1)).toBe(getAiGatewayPersonRoute(orgSlug, person.id));
    expect(view.calls.every((call) => call.init.method === "GET")).toBe(true);
  } finally { await view.close(); }
});

test("reset review locks both controls while pending and reports a successful expired response honestly", async () => {
  let resolve: ((reply: Reply) => void) | undefined;
  let current = reset();
  const view = await mount(<GatewayUsageResetRequests orgId={orgId} members={[]} />, (call) => {
    if (call.init.method === "POST") return new Promise<Reply>((done) => { resolve = done; });
    return resetListReply(call.path, [current]);
  });
  try {
    await click("Approve 25% for Example Member, 1 month");
    expect(button("Approve 25% for Example Member, 1 month").disabled).toBe(true);
    expect(button("Deny request for Example Member, 1 month").disabled).toBe(true);
    await click("Deny request for Example Member, 1 month");
    expect(view.calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
    current = { ...current, status: "expired" };
    await act(async () => resolve?.({ payload: current }));
    await tick();
    expect(view.container.textContent).toContain("No extension was granted by this decision");
    expect(view.container.textContent).not.toContain("Request approved");
    expect(view.container.textContent).toContain("No pending requests");
  } finally { await view.close(); }
});

test("reset queue handles failed reads and disables zero-base and elapsed-period approvals", async () => {
  let failed = true;
  const view = await mount(<GatewayUsageResetRequests orgId={orgId} members={[]} />, (call) => {
    if (call.path === policiesPath || call.path.includes("view=history")) return defaultReply(call);
    return failed
      ? { status: 503, payload: { error: "unavailable", message: "Review queue unavailable" } }
      : { payload: resetPage("pending", [{ ...reset(), baseAllowanceMicroUsd: 0, allowanceMicroUsd: 0, resetAt: "2020-01-01T05:00:00.000Z" }], 1) };
  });
  try {
    expect(view.container.textContent).toContain("Review queue unavailable");
    expect(view.container.textContent).not.toContain("No pending requests");
    failed = false;
    await click("Retry increase requests");
    expect(button("Approve 25% for Example Member, 1 month").disabled).toBe(true);
    expect(view.container.textContent).toContain("This period ended");
    expect(view.container.textContent).toContain("zero base allowance");
  } finally { await view.close(); }
});

test("paginates pending and lazy history independently beyond fifty without dropping ineligible rows", async () => {
  const queued = Array.from({ length: 51 }, (_, index): GatewayUsageResetRequest => ({ ...reset(), id: `pending-${index}`, memberName: `Queued person ${index}`, status: index === 49 ? "expired" : "pending" }));
  const history = Array.from({ length: 51 }, (_, index): GatewayUsageResetRequest => ({ ...reset(), id: `history-${index}`, memberName: `Historical person ${index}`, status: "approved" }));
  const view = await mount(<GatewayUsageResetRequests orgId={orgId} members={[]} />, ({ path }) => {
    if (path === policiesPath || path === `${resetsPath}?view=history&limit=1`) return resetListReply(path, history);
    const params = new URLSearchParams(path.split("?")[1]);
    const list = params.get("view") === "history" ? "history" : "pending";
    const rows = list === "history" ? history : queued;
    const cursor = params.get("cursor");
    expect(params.get("limit")).toBe("50");
    if (cursor) expect(cursor).toBe(`${list}-cursor`);
    return { payload: resetPage(list, cursor ? rows.slice(50) : rows.slice(0, 50), 51, cursor ? null : `${list}-cursor`) };
  });
  try {
    expect(view.calls.map((call) => call.path)).toEqual([policiesPath, `${resetsPath}?view=pending&limit=50`, `${resetsPath}?view=history&limit=1`]);
    expect(view.container.querySelectorAll("tbody tr:nth-child(odd)")).toHaveLength(50);
    expect(view.container.textContent).not.toContain("queued requests loaded");
    expect(view.container.textContent).not.toContain("Pending queue:");
    expect(view.container.textContent).toContain("Last checked:");
    expect(view.container.textContent).toContain("Expired / ineligible");
    expect(button("Approve 25% for Queued person 49, 1 month").disabled).toBe(true);
    expect(button("Approve 25% for Queued person 49, 1 month").hasAttribute("aria-describedby")).toBe(false);
    expect(button("Deny request for Queued person 49, 1 month").disabled).toBe(true);
    await click("Load more pending requests");
    expect(view.container.querySelectorAll("tbody tr:nth-child(odd)")).toHaveLength(51);
    expect(view.container.textContent).toContain("Queued person 50");
    expect(view.container.textContent).not.toContain("Load more pending requests");
    expect(view.calls.filter((call) => call.path.includes("view=history")).map((call) => call.path)).toEqual([`${resetsPath}?view=history&limit=1`]);
    await toggleHistory();
    expect(view.container.querySelectorAll('#gateway-reset-history tbody tr:nth-child(odd)')).toHaveLength(50);
    expect(view.calls.at(-1)?.path).toBe(`${resetsPath}?view=history&limit=50`);
    await click("Load more history");
    expect(view.container.querySelectorAll('#gateway-reset-history tbody tr:nth-child(odd)')).toHaveLength(51);
    expect(view.container.textContent).toContain("Historical person 50");
    expect(view.calls.at(-1)?.path).toBe(`${resetsPath}?view=history&limit=50&cursor=history-cursor`);
    await toggleHistory();
    await toggleHistory();
    expect(view.calls.at(-1)?.path).toBe(`${resetsPath}?view=history&limit=50`);
    expect(view.container.querySelectorAll('#gateway-reset-history tbody tr:nth-child(odd)')).toHaveLength(50);
    const beforeRefresh = view.calls.length;
    await click("Refresh", view.container.querySelector('[aria-label="Pending increase request pages"]') ?? undefined);
    expect(view.calls.slice(beforeRefresh).map((call) => call.path)).toEqual([`${resetsPath}?view=pending&limit=50`, `${resetsPath}?view=history&limit=1`]);
    expect(view.container.querySelectorAll('[aria-label="Pending increase request pages"] tbody tr:nth-child(odd)')).toHaveLength(50);
  } finally { await view.close(); }
});

test("next-page failure retains loaded rows and offers retry without silently reporting completion", async () => {
  let fail = true;
  const view = await mount(<GatewayUsageResetRequests orgId={orgId} members={[]} />, ({ path }) => {
    if (path === policiesPath || path.includes("view=history")) return resetListReply(path, []);
    if (path.includes("cursor=")) return fail ? { status: 503, payload: { error: "unavailable", message: "Next page unavailable" } } : { payload: resetPage("pending", [{ ...reset(), id: "second", memberName: "Second person" }], 2) };
    return { payload: resetPage("pending", [reset()], 2, "next-page") };
  });
  try {
    await click("Load more pending requests");
    expect(view.container.textContent).toContain("Next page unavailable");
    expect(view.container.textContent).toContain("Only previously loaded entries are shown");
    expect(view.container.querySelectorAll("tbody tr:nth-child(odd)")).toHaveLength(1);
    expect(button("Approve 25% for Example Member, 1 month").disabled).toBe(true);
    fail = false;
    await click("Retry more pending requests");
    expect(view.container.querySelectorAll("tbody tr:nth-child(odd)")).toHaveLength(2);
    expect(view.container.textContent).not.toContain("Next page unavailable");
  } finally { await view.close(); }
});

test("org switching clears cursors, cached rows, decisions and history expansion", async () => {
  const { ORG_SCOPE_HEADER } = await import("../app/(den)/_lib/org-scope");
  const view = await mount(<GatewayUsageResetRequests orgId={orgId} members={[]} />, ({ path, init }) => {
    const scope = new Headers(init.headers).get(ORG_SCOPE_HEADER);
    if (path === policiesPath || path === `${resetsPath}?view=history&limit=1`) return resetListReply(path, [{ ...reset(), status: "denied" }]);
    const params = new URLSearchParams(path.split("?")[1]);
    const list = params.get("view") === "history" ? "history" : "pending";
    const cursor = params.get("cursor");
    if (scope === "org-second") expect(cursor).toBeNull();
    return { payload: resetPage(list, [{ ...reset(), id: `${scope}-${list}-${cursor ?? "first"}`, memberName: scope === "org-second" ? "Second organization" : "First organization", status: list === "history" ? "denied" : "pending" }], 2, cursor ? null : `${scope}-${list}-cursor`) };
  });
  try {
    await click("Load more pending requests");
    await toggleHistory();
    await click("Load more history");
    const before = view.calls.length;
    await view.rerender(<GatewayUsageResetRequests orgId="org-second" members={[]} />);
    expect(view.calls.slice(before).map((call) => call.path)).toEqual([policiesPath, `${resetsPath}?view=pending&limit=50`, `${resetsPath}?view=history&limit=1`]);
    for (const call of view.calls.slice(before)) expect(new Headers(call.init.headers).get(ORG_SCOPE_HEADER)).toBe("org-second");
    expect(view.container.textContent).toContain("Second organization");
    expect(view.container.textContent).not.toContain("First organization");
    expect(view.container.querySelector('#gateway-reset-history')).toBeNull();
    expect(view.container.querySelector("details")?.open).toBe(false);
    expect(view.client.getQueryCache().findAll({ queryKey: gatewayLimitsKey(orgId) })).toHaveLength(0);
    await toggleHistory();
    expect(view.calls.at(-1)?.path).toBe(`${resetsPath}?view=history&limit=50`);
  } finally { await view.close(); }
});

test("a review invalidates both mounted reset views and other usage caches only in its org", async () => {
  let current = reset();
  const previous = { ...reset(), id: "previous-request", status: "approved" } satisfies GatewayUsageResetRequest;
  const view = await mount(<GatewayUsageResetRequests orgId={orgId} members={[]} />, (call) => {
    if (call.init.method === "POST") { current = { ...current, status: "denied" }; return { payload: current }; }
    return resetListReply(call.path, [current, previous]);
  });
  try {
    const keys = [["usage", person.id], ["assignments", "policy-fixture"], ["policies"], ["reset-requests", "pending"], ["reset-requests", "history"], ["reset-history-available"]];
    for (const key of keys) view.client.setQueryData([...gatewayLimitsKey("other-org"), ...key], { existing: true });
    for (const key of keys.slice(0, 2)) view.client.setQueryData([...gatewayLimitsKey(orgId), ...key], { existing: true });
    await toggleHistory();
    const count = (list: string) => view.calls.filter((call) => call.path === `${resetsPath}?view=${list}&limit=50`).length;
    const pendingReads = count("pending");
    const historyReads = count("history");
    await click("Deny request for Example Member, 1 month");
    expect(count("pending")).toBeGreaterThan(pendingReads);
    expect(count("history")).toBeGreaterThan(historyReads);
    expect(view.container.querySelector('#gateway-reset-history')?.textContent).toContain("denied");
    expect(view.container.textContent).toContain("No pending requests");
    expect(view.calls.filter((call) => call.path === policiesPath)).toHaveLength(2);
    expect(view.calls.filter((call) => call.path === `${resetsPath}?view=history&limit=1`)).toHaveLength(2);
    for (const key of keys.slice(0, 2)) expect(view.client.getQueryState([...gatewayLimitsKey(orgId), ...key])?.isInvalidated).toBe(true);
    for (const key of keys) expect(view.client.getQueryState([...gatewayLimitsKey("other-org"), ...key])?.isInvalidated).toBe(false);
  } finally { await view.close(); }
});

test("inspector preserves server-selected provenance/revision and reports quarantined history with zero unpriced requests", async () => {
  const usage: GatewayUsageStatus = { ...status(), coverage: { complete: false, unpricedRequests: 0, quarantinedRequests: 7 }, buckets: status().buckets.map((bucket) => ({ ...bucket, policyRevision: 6, provenance: [
    { kind: "direct", assignmentId: "snapshot-direct", memberId: person.id, teamId: null },
    { kind: "team", assignmentId: "snapshot-team", memberId: null, teamId: team.id, teamName: "Snapshot Team" },
  ] })) };
  const view = await mount(<GatewayMemberUsageDetails status={usage} policies={[policy()]} teams={[team]} />);
  try {
    const summary = view.container.querySelector<HTMLElement>('summary[aria-label="Effective policy and assignment context for Standard - 1 month"]');
    await act(async () => summary?.click());
    const snapshot = view.container.querySelector('[aria-label="Server-selected assignment snapshot"]');
    if (!snapshot) throw new Error("Missing server-selected snapshot");
    expectField(snapshot, "Policy", "Standard");
    expectField(snapshot, "Revision", "6");
    expect(snapshot.textContent).toContain("Direct assignment");
    expect(snapshot.textContent).toContain("Team: Snapshot Team");
    for (const id of ["policy-fixture", "bucket-fixture", person.id, team.id, "snapshot-direct", "snapshot-team"]) {
      expect(view.container.textContent).not.toContain(id);
    }
    expect(view.container.textContent).not.toContain("·");
    expect(snapshot.textContent).not.toContain("Example Team");
    expect(view.container.textContent).toContain("Current-directory policy comparison");
    expect(view.container.textContent).toContain("not the server-selected snapshot");
    expect(view.container.textContent).toContain("7 unresolved historical requests are quarantined");
    expect(view.container.textContent).not.toContain("0 unpriced");
    expect(view.container.textContent).not.toContain("Accounting coverage complete");
    expect(view.container.textContent).not.toContain("are not supplied by the usage API");
  } finally { await view.close(); }
});

test("rejects a paginated response with a different view or missing continuation cursor", async () => {
  for (const malformed of [resetPage("history", [reset()], 1), { ...resetPage("pending", [reset()], 2), hasMore: true }]) {
    const view = await mount(<GatewayUsageResetRequests orgId={orgId} members={[]} />, (call) => call.path === policiesPath || call.path.includes("view=history") ? defaultReply(call) : { payload: malformed });
    try {
      expect(view.container.textContent).toContain("inconsistent pagination");
      expect(view.container.querySelector("tbody")).toBeNull();
      expect(view.calls.filter((call) => call.path.includes("view=pending"))).toHaveLength(1);
    } finally { await view.close(); }
  }
});

test.each([
  { name: "settled writes with unknown historical coverage", coverage: trackedCoverage(), shown: ["This period includes time before usage tracking started", "Earlier usage is unknown", "Usage tracking started:", "No tracked requests are awaiting settlement", "Last settlement:"], hidden: ["0 recorded requests", "Accounting coverage complete"] },
  { name: "tracking not started", coverage: trackedCoverage({ historicalUnknownReason: "tracking_not_started", trackingStartedAt: null, pendingRequests: null, settlementReady: false, lastSettlementAt: null, lastSettlementRequestId: null }), shown: ["Usage tracking has not started", "Pending settlement count is unavailable"], hidden: ["0 recorded requests", "No tracked requests", "Last settlement:", "Usage tracking started:"] },
  { name: "pending and incomplete costs separately", coverage: trackedCoverage({ pendingRequests: 2, settlementReady: false, unpricedRequests: 3, incompleteRequests: 4 }), shown: ["2 tracked requests are awaiting settlement", "3 recorded requests have unresolved cost", "4 recorded requests have incomplete accounting", "Unknown cost is not zero"], hidden: ["No tracked requests", "9 recorded requests", "Accounting coverage complete"] },
  { name: "settled writes with unresolved costs", coverage: trackedCoverage({ unpricedRequests: 3, incompleteRequests: 4 }), shown: ["No tracked requests are awaiting settlement", "3 recorded requests have unresolved cost", "4 recorded requests have incomplete accounting"], hidden: ["Accounting coverage complete"] },
  { name: "legacy incomplete coverage with zero priced gaps", coverage: { complete: false, unpricedRequests: 0 }, shown: ["Accounting is incomplete", "Known costs are a subtotal"], hidden: ["0 requests", "0 recorded requests", "tracking has not started", "No tracked requests"] },
  { name: "legacy counters with unknown coverage", coverage: trackedCoverage({ historicalUnknownReason: "legacy_counter" }), shown: ["older counters with unknown coverage"], hidden: ["Accounting coverage complete", "0 recorded requests"] },
])("usage details preserve and distinguish $name", async ({ coverage, shown, hidden }) => {
  const usage: GatewayUsageStatus = { ...status(), state: "unlimited", buckets: [], coverage };
  const view = await mount(<GatewayMemberUsageDetails status={usage} policies={[]} teams={[]} />);
  try {
    for (const text of shown) expect(view.container.textContent).toContain(text);
    for (const text of hidden) expect(view.container.textContent).not.toContain(text);
    expect(view.container.textContent).toContain("No usage limit policy assigned");
    expect(view.container.textContent).not.toContain("request_settled");
  } finally { await view.close(); }
});

test("remote combobox retains the selected label but never selects pending, removed or failed results", async () => {
  const selected: string[] = [];
  const searches: string[] = [];
  const option = { value: person.id, label: person.name, description: person.email };
  const node = (options: typeof option[], optionsDisabled = false, value = person.id) => <DenCombobox ariaLabel="Remote person" value={value} options={options} optionsDisabled={optionsDisabled} serverFiltered maxSearchLength={200} onSearchChange={(query) => searches.push(query)} onChange={(id) => selected.push(id)} />;
  const view = await mount(node([option]));
  try {
    await view.rerender(node([]));
    const input = view.container.querySelector<HTMLInputElement>('[aria-label="Remote person"]');
    if (!input) throw new Error("Missing remote picker");
    expect(input.value).toBe(person.name);
    await act(async () => { input.focus(); input.click(); });
    await fill('[aria-label="Remote person"]', "not a local match");
    await view.rerender(node([option], true));
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    expect(view.container.querySelector<HTMLButtonElement>('[role="option"]')?.disabled).toBe(true);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      view.container.querySelector('[role="option"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(selected).toEqual([]);
    await view.rerender(node([option]));
    expect(view.container.querySelector('[role="option"]')?.textContent).toContain(person.name);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(selected).toEqual([person.id]);
    await tick();
    await view.rerender(node([], true));
    await act(async () => { input.focus(); input.click(); });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(selected).toEqual([person.id]);
    expect(searches).toContain("not a local match");
    await view.rerender(node([], false, "different-member"));
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(input.value).toBe("");
  } finally { await view.close(); }
});

test("person lookup pins encoded search to the latest response and cannot select an earlier request", async () => {
  pushed.length = 0;
  let resolveEarlier: ((reply: Reply) => void) | undefined;
  let resolveLatest: ((reply: Reply) => void) | undefined;
  const view = await mount(section(), (call) => {
    if (call.path === `${membersPath}?query=Earlier`) return new Promise<Reply>((resolve) => { resolveEarlier = resolve; });
    if (call.path === `${membersPath}?query=Example+%26+member`) return new Promise<Reply>((resolve) => { resolveLatest = resolve; });
    return defaultReply(call);
  });
  try {
    const input = view.container.querySelector<HTMLInputElement>('[aria-label="Find a person"]');
    if (!input) throw new Error("Missing member search");
    await act(async () => { input.focus(); input.click(); });
    expect(input.maxLength).toBe(200);
    await fill('[aria-label="Find a person"]', "Earlier");
    await fill('[aria-label="Find a person"]', "Example & member");
    expect(resolveEarlier).toBeDefined();
    expect(resolveLatest).toBeDefined();
    await act(async () => resolveEarlier?.({ payload: { members: [{ ...person, id: "stale-member", name: "Stale person" }] } }));
    await tick();
    expect(view.container.textContent).not.toContain("Stale person");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(view.calls.some((call) => call.path.startsWith(`${membersPath}/`))).toBe(false);
    await act(async () => resolveLatest?.({ payload: { members: [person] } }));
    await tick();
    await choose("Find a person", "Example Member");
    expect(pushed.at(-1)).toBe(getAiGatewayPersonRoute(orgSlug, person.id));
    expect(view.calls.some((call) => call.path.startsWith(`${membersPath}/`))).toBe(false);
    const { ORG_SCOPE_HEADER } = await import("../app/(den)/_lib/org-scope");
    for (const call of view.calls) expect(new Headers(call.init.headers).get(ORG_SCOPE_HEADER)).toBe(orgId);
  } finally { await view.close(); }
});

test("soft exhaustion explicitly leaves requests allowed with complete estimated accounting", async () => {
  const usage: GatewayUsageStatus = { ...status(), state: "over_limit", coverage: { complete: true, unpricedRequests: 0 }, buckets: status().buckets.map((bucket) => ({ ...bucket, hardLimit: false })) };
  const view = await mount(<GatewayMemberUsageDetails status={usage} policies={[]} teams={[]} />);
  try {
    expect(view.container.textContent).toContain("Requests are still allowed");
    expect(view.container.textContent).toContain("Recorded accounting complete. All costs are estimates.");
    expect(view.container.textContent).not.toContain("blocks further");
  } finally { await view.close(); }
});
