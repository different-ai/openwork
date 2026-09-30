import { afterAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { DenLlmProvider } from "../app/(den)/dashboard/_components/llm-provider-data";
import type { GatewayAccessGrant, GatewayAudience } from "@openwork/types/den/gateway";
import type { GatewayUsageLimitPolicy } from "@openwork/types/den/gateway-usage-limits";

GlobalRegistrator.register({ url: "https://app.example.test/dashboard/ai-gateway" });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(() => GlobalRegistrator.unregister());
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const navigation = await import("next/navigation");
const organization = await import("../app/(den)/dashboard/_providers/org-dashboard-provider");
const capability = await import("../app/(den)/dashboard/_components/gateway-dashboard-capability-guard");
const { getGatewayDashboardAccess } = await import("../app/(den)/dashboard/_lib/gateway-dashboard-access");
const models = await import("../app/(den)/dashboard/_components/inference-screen");
const requests = await import("../app/(den)/_lib/den-flow");
const legacyData = await import("../app/(den)/dashboard/_components/llm-provider-data");
const { parseOrgContextPayload } = await import("../app/(den)/_lib/den-org");
const { ORG_SCOPE_HEADER } = await import("../app/(den)/_lib/org-scope");
const { AiGatewayScreen } = await import("../app/(den)/dashboard/_components/ai-gateway-screen");
const { GatewayUsersTeamsSection } = await import("../app/(den)/dashboard/_components/gateway-users-teams-section");
const { LegacyProvidersSection } = await import("../app/(den)/dashboard/_components/llm-providers-screen");
const { directoryLimit, limitSourceLabel, limitSummary } = await import("../app/(den)/dashboard/_components/gateway-directory-data");

const orgId = "org-fixture";
const memberId = "membership-fixture";
const teamId = "team-fixture";
const providersPath = "/v1/inference-providers?scope=manageable";
const policiesPath = "/v1/gateway/usage-limit-policies";
const noop = async () => {};
const directory = parseOrgContextPayload({
  organization: { id: orgId, name: "Fixture Workspace", slug: "fixture" },
  deploymentCapabilities: { version: 1, aiGateway: true },
  currentMember: { id: "admin-member", userId: "admin-user", role: "owner", isOwner: true },
  members: [{ id: memberId, userId: "user-fixture", role: "member", user: { id: "user-fixture", name: "Example Person", email: "person@example.test" } }],
  teams: [
    { id: teamId, name: "Alpha Team", memberIds: [memberId] },
    { id: "other-team", name: "Other Team", memberIds: [] },
  ],
});
if (!directory) throw new Error("Invalid organization fixture");

function grant(audience: GatewayAudience, id = "grant-fixture"): GatewayAccessGrant {
  return { id, audience, modelGroupId: "group-fixture", credentialSetId: "key-fixture" };
}
function provider(accessGrants: GatewayAccessGrant[] = []) {
  return {
    id: "provider/fixture", providerId: "openai", name: "Fixture Provider", credentialMode: "org", status: "active", modelIds: [],
    modelGroups: [{ id: "group-fixture", name: "Selected models", description: null, status: "active", modelIds: ["model-one", "model-two"] }],
    credentialSets: [{ id: "key-fixture", name: "Shared upstream", credentialMode: "org", status: "active", configured: true, credentialStatus: "ready" }],
    accessGrants,
  };
}
function policy(assignments: GatewayUsageLimitPolicy["assignments"] = [], overrides: Partial<GatewayUsageLimitPolicy> = {}): GatewayUsageLimitPolicy {
  return { id: "policy-fixture", name: "Standard", revision: 7, hardLimit: true, allowRequestReset: true, limits: [{ timeframe: "month", costLimitMicroUsd: 100_000_001 }], assignments, ...overrides };
}
function assigned(target: { organization: true } | { teamId: string } | { memberId: string }, id = "assignment"): GatewayUsageLimitPolicy["assignments"][number] {
  return { id, organization: "organization" in target, teamId: "teamId" in target ? target.teamId : null, memberId: "memberId" in target ? target.memberId : null };
}
function usage(groupBy: "person" | "team", series: { id: string; label: string; costMicroUsd: number }[]) {
  const today = new Date();
  const to = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const daily = Array.from({ length: 31 }, (_, index) => {
    const date = new Date(to - (30 - index) * 86_400_000).toISOString().slice(0, 10);
    const last = index === 30;
    return {
      date,
      totalTokens: last ? series.length * 10 : 0,
      values: last ? Object.fromEntries(series.map((row) => [row.id, 10])) : {},
      totalCostMicroUsd: last ? series.reduce((sum, row) => sum + row.costMicroUsd, 0) : 0,
      costValues: last ? Object.fromEntries(series.map((row) => [row.id, row.costMicroUsd])) : {},
    };
  });
  return { usage: {
    groupBy, days: 31, from: daily[0].date, to: daily[30].date, timezone: "UTC",
    totalTokens: series.length * 10, totalCostMicroUsd: series.reduce((sum, row) => sum + row.costMicroUsd, 0),
    unreportedRequests: 0, unpricedRequests: 0, series: series.map(({ id, label }) => ({ id, label })), daily, filterOptions: [],
  } };
}

type Call = { path: string; init: RequestInit };
type Reply = { payload: unknown; status?: number };
type Handler = (call: Call) => Reply | Promise<Reply>;
function reply({ path }: Call): Reply {
  if (path === providersPath) return { payload: { inferenceProviders: [provider()] } };
  if (path === policiesPath) return { payload: { policies: [policy()] } };
  if (path.startsWith("/v1/gateway/usage-limits/members?")) return { payload: { members: [] } };
  if (path.startsWith("/v1/inference-providers/usage?")) return { status: 503, payload: { error: "unavailable", message: "Usage unavailable" } };
  if (path.startsWith("/v1/gateway/usage-limit-reset-requests?")) {
    const params = new URLSearchParams(path.split("?")[1]);
    return { payload: { requests: [], view: params.get("view"), limit: Number(params.get("limit")), pendingCount: 0, hasMore: false, nextCursor: null } };
  }
  throw new Error(`Unexpected request: ${path}`);
}
const tick = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); };
async function mount(node: ReactNode, handler: Handler = reply, tab = "users-and-teams", extra = "") {
  const calls: Call[] = [];
  const pushes: { href: string; scroll?: boolean }[] = [];
  const reauth: string[] = [];
  const reauthErrors: unknown[] = [];
  const org = spyOn(organization, "useOrgDashboard").mockReturnValue({
    orgSlug: "fixture", orgId, orgDirectory: [], activeOrg: null, orgContext: directory,
    orgSelectionOpen: false, orgBusy: false, orgError: null, mutationBusy: null, reauthDialogOpen: false, orgSettingsCompletion: null,
    clearOrgSettingsCompletion: noop, refreshOrgData: noop, createOrganization: noop,
    updateOrganizationName: noop, updateOrganizationSettings: noop, deleteOrganization: noop,
    switchOrganization: noop, inviteMember: noop, startSeatCheckout: noop, cancelInvitation: noop,
    updateMemberRole: noop, removeMember: noop, transferOwnership: noop,
    createTeam: noop, updateTeam: noop, deleteTeam: noop, createRole: noop, updateRole: noop, deleteRole: noop,
    runReauthableAction: async (label, action) => {
      reauth.push(label);
      try { return await action(); } catch (error) { reauthErrors.push(error); throw error; }
    },
  });
  const access = spyOn(capability, "useGatewayDashboardAccess").mockImplementation(() => getGatewayDashboardAccess(organization.useOrgDashboard()));
  const search = spyOn(navigation, "useSearchParams").mockReturnValue(new navigation.ReadonlyURLSearchParams(`tab=${tab}&keep=value${extra}`));
  const router = spyOn(navigation, "useRouter").mockReturnValue({
    push(href, options) { pushes.push({ href, scroll: options?.scroll }); }, replace() {}, refresh() {}, back() {}, forward() {}, prefetch: noop, bfcacheId: "fixture",
  });
  const legacy = spyOn(legacyData, "useOrgLlmProviders").mockReturnValue({ llmProviders: [], busy: false, error: null, reloadProviders: noop });
  const request = spyOn(requests, "requestJson").mockImplementation(async (path, init = {}) => {
    calls.push({ path, init });
    const result = await handler({ path, init });
    return { payload: result.payload, response: result.status === 204 ? new Response(null, { status: 204 }) : Response.json(result.payload, { status: result.status ?? 200 }), text: JSON.stringify(result.payload) };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (next: ReactNode) => { await act(async () => root.render(<QueryClientProvider client={client}>{next}</QueryClientProvider>)); await tick(); };
  await render(node);
  return { calls, pushes, reauth, reauthErrors, client, container, access, legacy, render,
    async tab(value: string) { search.mockReturnValue(new navigation.ReadonlyURLSearchParams(`tab=${value}&keep=value`)); await render(<AiGatewayScreen />); },
    async close() { await act(async () => root.unmount()); client.clear(); request.mockRestore(); legacy.mockRestore(); router.mockRestore(); search.mockRestore(); access.mockRestore(); org.mockRestore(); container.remove(); },
  };
}
function link(testId: string, scope: ParentNode = document.body) {
  return [...scope.querySelectorAll(`[data-testid="${testId}"]`)].map((element) => ({ href: element.getAttribute("href"), text: element.textContent ?? "" }));
}
function button(label: string, scope: ParentNode = document.body) {
  const result = [...scope.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === label || element.textContent === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(label: string, scope?: ParentNode) {
  await act(async () => button(label, scope).click());
  await tick();
}
function writes(calls: Call[]) { return calls.filter((call) => call.init.method !== "GET"); }
const subjectSection = (context = directory) => <GatewayUsersTeamsSection orgId={orgId} orgSlug="fixture" orgContext={context} />;

test("root tabs navigate without losing query context and nested content keeps AI Providers active", async () => {
  const view = await mount(<AiGatewayScreen providerContent={<div>Nested provider editor</div>} />, reply, "limits");
  try {
    expect([...view.container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(["Overview", "AI Providers", "Limits", "Users & Teams", "OpenWork Models"]);
    expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("AI Providers");
    expect(view.container.querySelector('[role="tabpanel"]')?.getAttribute("aria-label")).toBe("AI Providers");
    expect(view.container.textContent).toContain("Nested provider editor");
    expect(view.calls).toEqual([]);
    await click("Limits");
    await click("Overview");
    expect(view.pushes).toEqual([
      { href: "/dashboard/ai-gateway?tab=limits&keep=value", scroll: false },
      { href: "/dashboard/ai-gateway?keep=value", scroll: false },
    ]);
  } finally { await view.close(); }
});

test("Limits owns policies, inspection and reset review while Users & Teams owns assignments", async () => {
  const view = await mount(<AiGatewayScreen />, reply, "limits");
  try {
    await tick();
    const panel = view.container.querySelector('[data-testid="ai-gateway-panel-limits"]');
    expect(panel?.querySelector('[aria-labelledby="gateway-usage-limits-heading"]')).not.toBeNull();
    expect(panel?.querySelector('[aria-label="Find a person"]')).not.toBeNull();
    expect(panel?.textContent).toContain("No pending requests");
    expect(panel?.querySelector('[data-testid="gateway-limit-new"]')?.getAttribute("href")).toBe("/dashboard/ai-gateway/limits/new");
    expect(panel?.querySelector('[aria-label="Edit Standard"]')?.getAttribute("href")).toBe("/dashboard/ai-gateway/limits/policy-fixture");
    expect(view.container.querySelector('[data-testid="gateway-users-teams"]')).toBeNull();
    expect(view.calls.some((call) => call.path.includes("view=pending"))).toBe(true);
    expect(view.calls.some((call) => call.path === providersPath)).toBe(false);
    await view.tab("users-and-teams");
    expect(view.container.querySelector('[data-testid="gateway-users-teams"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-labelledby="gateway-usage-limits-heading"]')).toBeNull();
    expect(view.container.querySelector('[aria-label="Find a person"]')).toBeNull();
    for (const call of view.calls) expect(new Headers(call.init.headers).get(ORG_SCOPE_HEADER)).toBe(orgId);
  } finally { await view.close(); }
});

test.each(["checking", "denied", "unavailable"] satisfies ReturnType<typeof capability.useGatewayDashboardAccess>[])("%s access keeps tabs visible but never mounts sensitive gateway queries", async (state) => {
  const view = await mount(<div />);
  try {
    view.access.mockReturnValue(state);
    for (const tab of ["overview", "limits", "users-and-teams", "ai-providers"]) {
      await view.tab(tab);
      expect(view.container.querySelectorAll('[role="tab"]')).toHaveLength(5);
      expect(view.container.querySelector('[data-testid="gateway-users-teams"]')).toBeNull();
      expect(view.container.querySelector('[aria-labelledby="gateway-usage-limits-heading"]')).toBeNull();
    }
    expect(view.calls).toEqual([]);
    expect(view.container.textContent).toContain(state === "checking" ? "Checking workspace access" : state === "unavailable" ? "ask an instance admin" : "AI Gateway requires workspace admin permissions. Ask a workspace owner to update your role.");
  } finally { await view.close(); }
});

test.each(["checking", "denied", "unavailable", "enabled"] satisfies ReturnType<typeof capability.useGatewayDashboardAccess>[])("Models delegates to its own embedded guard with %s gateway access and no gateway requests", async (state) => {
  const screen = spyOn(models, "InferenceScreen").mockImplementation(({ embedded }) => <section data-testid="models-content" data-embedded={embedded} />);
  const view = await mount(<div />);
  try {
    view.access.mockReturnValue(state);
    await view.tab("openwork-models");
    expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("OpenWork Models");
    expect(view.container.querySelector('[data-testid="ai-gateway-panel-openwork-models"] [data-testid="models-content"]')?.getAttribute("data-embedded")).toBe("true");
    expect(view.calls).toEqual([]);
  } finally { await view.close(); screen.mockRestore(); }
});

test("AI Providers uses nested links and always offers legacy copy and creation", async () => {
  const view = await mount(<AiGatewayScreen />, reply, "ai-providers");
  try {
    expect(view.container.querySelector('[data-testid="gateway-provider-create"]')?.getAttribute("href")).toBe("/dashboard/ai-gateway/providers/new");
    expect(view.container.querySelector('[data-testid="gateway-provider-open"]')?.getAttribute("href")).toBe("/dashboard/ai-gateway/providers/provider%2Ffixture");
    expect(view.container.querySelector('[data-testid="gateway-legacy-providers"]')).not.toBeNull();
    for (const state of [{ busy: false, error: null }, { busy: true, error: null }, { busy: false, error: "Legacy unavailable" }]) {
      view.legacy.mockReturnValue({ llmProviders: [], reloadProviders: noop, ...state });
      await view.render(<LegacyProvidersSection orgId={orgId} orgSlug="fixture" />);
      expect(view.container.textContent).toContain("send the API key directly to users’ desktop applications");
      expect(view.container.textContent).toContain("Usage tracking and usage limit policies are not available");
      expect(view.container.querySelector('[data-testid="legacy-provider-create"]')?.getAttribute("href")).toBe("/dashboard/custom-llm-providers/new");
      if (state.error) expect(button("Retry legacy providers").disabled).toBe(false);
    }
    const legacy: DenLlmProvider = {
      id: "legacy-fixture", organizationId: orgId, createdByOrgMembershipId: "admin-member", source: "custom", providerId: "fixture", name: "Visible legacy provider",
      providerConfig: {}, hasApiKey: true, configuredEnvKeys: [], runtimeEnvKeys: [], createdAt: null, updatedAt: null, canManage: true,
      accessibleVia: { orgMembershipIds: [], teamIds: [] }, models: [], access: { allMembers: false, members: [], teams: [] },
    };
    view.legacy.mockReturnValue({ busy: false, error: null, reloadProviders: noop, llmProviders: [
      legacy, { ...legacy, id: "managed", source: "openwork", name: "Managed model must not leak" },
      { ...legacy, id: "foreign", organizationId: "different-org", name: "Foreign provider must not leak" },
    ] });
    await view.render(<LegacyProvidersSection orgId={orgId} orgSlug="fixture" />);
    expect(view.container.textContent).toContain("Visible legacy provider");
    expect(view.container.textContent).not.toContain("must not leak");
    expect(view.container.querySelector('[data-testid="legacy-provider-create"]')).not.toBeNull();
    expect(view.container.textContent).toContain("Usage tracking and usage limit policies are not available");
  } finally { await view.close(); }
});

test("unknown root tab falls back to Overview and invites provider setup without querying limits", async () => {
  const view = await mount(<AiGatewayScreen />, () => ({ payload: { inferenceProviders: [] } }), "unknown");
  try {
    expect(view.container.querySelector('[role="tabpanel"]')?.getAttribute("aria-label")).toBe("Overview");
    expect(view.container.querySelector('[data-testid="gateway-usage-add-provider"]')?.getAttribute("href")).toBe("/dashboard/ai-gateway/providers/new");
    expect(view.container.querySelector('[data-testid="gateway-usage-no-providers"]')?.textContent).toContain("No usage yet");
    expect(view.calls.map((call) => call.path)).toEqual([providersPath]);
  } finally { await view.close(); }
});

test("People lists everyone with what they can use, the limit that applies and 31-day spend, read-only", async () => {
  const view = await mount(subjectSection(), (call) => {
    if (call.path === providersPath) return { payload: { inferenceProviders: [provider([grant({ type: "organization" })])] } };
    if (call.path === policiesPath) return { payload: { policies: [policy([assigned({ organization: true })])] } };
    if (call.path.startsWith("/v1/inference-providers/usage?groupBy=person")) return { payload: usage("person", [{ id: memberId, label: "Example Person", costMicroUsd: 12_340_000 }]) };
    return reply(call);
  });
  try {
    const everyone = view.container.querySelector('[data-testid="gateway-directory-everyone"]');
    expect(everyone?.textContent).toContain("Everyone in Fixture Workspace");
    expect(everyone?.textContent).toContain("$100.000001 a month each");
    expect(everyone?.textContent).toContain("$12.34");
    expect(everyone?.querySelector('[aria-label="Can use Fixture Provider"]')).not.toBeNull();
    const rows = link("gateway-directory-person-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].href).toBe("/dashboard/ai-gateway/people/membership-fixture");
    expect(rows[0].text).toContain("Example Person");
    expect(rows[0].text).toContain("Alpha Team");
    expect(rows[0].text).toContain("$100.000001 a month");
    expect(rows[0].text).toContain("From Everyone");
    expect(rows[0].text).toContain("$12.34");
    expect(view.container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe("People · 1");
    expect(view.container.querySelectorAll('[role="dialog"], button[aria-label^="Remove"], button[aria-label^="Unassign"]')).toHaveLength(0);
    expect(writes(view.calls)).toEqual([]);
    for (const call of view.calls) expect(new Headers(call.init.headers).get(ORG_SCOPE_HEADER)).toBe(orgId);
    await click("Teams · 2");
    expect(view.pushes).toEqual([{ href: "/dashboard/ai-gateway?tab=users-and-teams&view=teams", scroll: false }]);
  } finally { await view.close(); }
});

test("a person's limit is the highest allowance that applies, named by where it comes from", async () => {
  let policies = [
    policy([assigned({ memberId }, "own")], { id: "own", name: "Own", limits: [{ timeframe: "month", costLimitMicroUsd: 50_000_000 }] }),
    policy([assigned({ teamId }, "team")], { id: "team", name: "Team", limits: [{ timeframe: "day", costLimitMicroUsd: 20_000_000 }, { timeframe: "month", costLimitMicroUsd: 200_000_000 }] }),
  ];
  const view = await mount(subjectSection(), (call) => call.path === policiesPath ? { payload: { policies } } : reply(call));
  try {
    let row = link("gateway-directory-person-row")[0];
    expect(row.text).toContain("$20.00 a day, $200.00 a month");
    expect(row.text).toContain("From Alpha Team");
    policies = [{ ...policies[0], limits: [{ timeframe: "month", costLimitMicroUsd: 300_000_000 }] }, { ...policies[1], limits: [{ timeframe: "month", costLimitMicroUsd: 200_000_000 }] }];
    await act(async () => { await view.client.invalidateQueries({ queryKey: ["gateway-usage-limits", orgId, "policies"] }); });
    await tick();
    row = link("gateway-directory-person-row")[0];
    expect(row.text).toContain("$300.00 a month");
    expect(row.text).toContain("Their own limit");
    expect(view.container.querySelector('[data-testid="gateway-directory-everyone"]')?.textContent).toContain("No limit");
  } finally { await view.close(); }
});

test("Teams lists each team and opening one filters People with the team's limit on top", async () => {
  const grants = [grant({ type: "team", teamId })];
  const view = await mount(<AiGatewayScreen />, (call) => {
    if (call.path === providersPath) return { payload: { inferenceProviders: [provider(grants)] } };
    if (call.path.startsWith("/v1/inference-providers/usage?groupBy=team")) return { payload: usage("team", [{ id: teamId, label: "Alpha Team", costMicroUsd: 4_000_000 }]) };
    return reply(call);
  }, "users-and-teams", "&view=teams");
  try {
    const teams = link("gateway-directory-team-row");
    expect(teams.map((row) => row.href)).toEqual(["/dashboard/ai-gateway?tab=users-and-teams&team=team-fixture", "/dashboard/ai-gateway?tab=users-and-teams&team=other-team"]);
    expect(teams[0].text).toContain("1 person");
    expect(teams[0].text).toContain("$4.00");
    expect(teams[0].text).toContain("No limit");
    expect(teams[1].text).toContain("Nothing yet");
    expect(view.container.querySelector('[data-testid="gateway-directory-people"]')).toBeNull();
  } finally { await view.close(); }

  const filtered = await mount(<AiGatewayScreen />, reply, "users-and-teams", "&team=other-team");
  try {
    expect(link("gateway-directory-team-filter")[0]).toEqual({ href: "/dashboard/ai-gateway?tab=users-and-teams", text: "TeamOther Team" });
    expect(filtered.container.querySelector('[data-testid="gateway-directory-everyone"]')).toBeNull();
    expect(link("gateway-directory-team-limit")[0]).toEqual({ href: "/dashboard/ai-gateway/limits/new?teamId=other-team", text: "Set a team limit" });
    expect(link("gateway-directory-person-row")).toHaveLength(0);
    expect(filtered.container.textContent).toContain("No one is in this team yet.");
  } finally { await filtered.close(); }

  const limited = await mount(<AiGatewayScreen />, (call) => call.path === policiesPath ? { payload: { policies: [policy([assigned({ teamId })])] } } : reply(call), "users-and-teams", `&team=${teamId}`);
  try {
    expect(link("gateway-directory-team-strip")[0].text).toContain("$100.000001 a month each");
    expect(link("gateway-directory-team-limit")[0]).toEqual({ href: "/dashboard/ai-gateway/limits/policy-fixture", text: "Edit team limit" });
    expect(link("gateway-directory-person-row").map((row) => row.href)).toEqual(["/dashboard/ai-gateway/people/membership-fixture"]);
  } finally { await limited.close(); }
});

test("Teams without any teams points to Members, and a removed team filter says so", async () => {
  const noTeams = parseOrgContextPayload({
    organization: { id: orgId, name: "Fixture Workspace", slug: "fixture" },
    deploymentCapabilities: { version: 1, aiGateway: true },
    currentMember: { id: "admin-member", userId: "admin-user", role: "owner", isOwner: true },
    members: [], teams: [],
  });
  if (!noTeams) throw new Error("Invalid organization fixture");
  const view = await mount(subjectSection(noTeams), reply, "users-and-teams", "&view=teams");
  try {
    const empty = view.container.querySelector('[data-testid="gateway-teams-empty"]');
    expect(empty?.textContent).toContain("No teams yet");
    expect(empty?.querySelector("a")?.getAttribute("href")).toBe("/dashboard/members");
    expect(view.container.querySelector('[aria-label="Filter teams by name"]')).toBeNull();
  } finally { await view.close(); }
  const removed = await mount(subjectSection(), reply, "users-and-teams", "&team=gone");
  try {
    expect(removed.container.textContent).toContain("This team no longer exists");
    expect(link("gateway-directory-team-filter")[0].text).toContain("Removed team");
    expect(removed.container.querySelector('[data-testid="gateway-directory-people"]')).toBeNull();
  } finally { await removed.close(); }
});

test("unverifiable provider definitions show an error with retry instead of an empty directory", async () => {
  let broken = true;
  const view = await mount(subjectSection(), (call) => call.path === providersPath && broken ? { payload: { inferenceProviders: [{ ...provider(), credentialSets: null }] } } : reply(call));
  try {
    expect(view.container.textContent).toContain("Provider access definitions are unavailable");
    expect(view.container.querySelector('[data-testid="gateway-directory-people"]')).toBeNull();
    broken = false;
    await click("Retry");
    expect(link("gateway-directory-person-row")).toHaveLength(1);
    expect(view.container.textContent).toContain("Spend could not be loaded.");
  } finally { await view.close(); }
});

test("limit labels stay honest for soft limits, mixed sources and archived policies", () => {
  const subject = { type: "member" as const, memberId, teamIds: [teamId] };
  const soft = policy([assigned({ organization: true })], { hardLimit: false });
  expect(limitSourceLabel(directoryLimit([soft], subject), subject, directory.teams)).toBe("From Everyone · warns only");
  const mixed = [
    policy([assigned({ teamId })], { id: "a", limits: [{ timeframe: "day", costLimitMicroUsd: 5_000_000 }] }),
    policy([assigned({ organization: true })], { id: "b", limits: [{ timeframe: "month", costLimitMicroUsd: 90_000_000 }] }),
  ];
  const limit = directoryLimit(mixed, subject);
  expect(limitSummary(limit, false)).toBe("$5.00 a day, $90.00 a month");
  expect(limitSourceLabel(limit, subject, directory.teams)).toBe("From Alpha Team and Everyone");
  expect(limitSummary(directoryLimit([policy([assigned({ memberId })], { archivedAt: "2026-01-01T00:00:00.000Z" })], subject), false)).toBe("No limit");
  expect(limitSummary(directoryLimit([policy([assigned({ memberId })])], { type: "team", teamId }), true)).toBe("No limit");
});
