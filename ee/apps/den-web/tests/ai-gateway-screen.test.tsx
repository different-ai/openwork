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
const { GatewayAccessWriteUncertainError, writeSubjectAccess } = await import("../app/(den)/dashboard/_components/gateway-subject-access-data");

const orgId = "org-fixture";
const memberId = "membership-fixture";
const teamId = "team-fixture";
const providersPath = "/v1/inference-providers?scope=manageable";
const policiesPath = "/v1/gateway/usage-limit-policies";
const grantsPath = "/v1/inference-providers/provider%2Ffixture/access-grants";
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
function policy(assignments: GatewayUsageLimitPolicy["assignments"] = []): GatewayUsageLimitPolicy {
  return { id: "policy-fixture", name: "Standard", revision: 7, hardLimit: true, allowRequestReset: true, limits: [{ timeframe: "month", costLimitMicroUsd: 100_000_001 }], assignments };
}

type Call = { path: string; init: RequestInit };
type Reply = { payload: unknown; status?: number };
type Handler = (call: Call) => Reply | Promise<Reply>;
function reply({ path }: Call): Reply {
  if (path === providersPath) return { payload: { inferenceProviders: [provider()] } };
  if (path === policiesPath) return { payload: { policies: [policy()] } };
  if (path.startsWith("/v1/gateway/usage-limits/members?")) return { payload: { members: [] } };
  if (path.startsWith("/v1/gateway/usage-limit-reset-requests?")) {
    const params = new URLSearchParams(path.split("?")[1]);
    return { payload: { requests: [], view: params.get("view"), limit: Number(params.get("limit")), pendingCount: 0, hasMore: false, nextCursor: null } };
  }
  throw new Error(`Unexpected request: ${path}`);
}
const tick = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); };
async function mount(node: ReactNode, handler: Handler = reply, tab = "users-and-teams") {
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
  const search = spyOn(navigation, "useSearchParams").mockReturnValue(new navigation.ReadonlyURLSearchParams(`tab=${tab}&keep=value`));
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
function button(label: string, scope: ParentNode = document.body) {
  const result = [...scope.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === label || element.textContent === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(label: string, scope?: ParentNode) {
  await act(async () => button(label, scope).click());
  await tick();
}
async function choose(label: string, text: string) {
  const input = document.querySelector<HTMLInputElement>(`[role="combobox"][aria-label="${label}"]`);
  if (!input) throw new Error(`Missing combobox: ${label}`);
  await act(async () => { input.focus(); input.click(); });
  await tick();
  const option = [...document.querySelectorAll('[role="option"]')].find((element) => element.querySelector("p")?.textContent === text);
  if (!option) throw new Error(`Missing option: ${text}`);
  await act(async () => option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  await tick();
}
async function selectSubject(kind: "organization" | "member" | "team") {
  if (kind === "organization") await click("Everyone in Fixture Workspace");
  else {
    if (kind === "member") await click("People (0)");
    const name = kind === "member" ? "Example Person" : "Alpha Team";
    const row = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button[aria-pressed]')].find((element) => element.querySelector("p")?.textContent === name);
    if (!row) throw new Error(`Missing subject: ${name}`);
    await act(async () => row.click());
    await tick();
  }
  await click("Continue");
}
function subjects() {
  return [...document.querySelectorAll('[data-testid="gateway-subject-card"]')].map((element) => element.getAttribute("data-subject"));
}
function writes(calls: Call[]) { return calls.filter((call) => call.init.method !== "GET"); }
const subjectSection = () => <GatewayUsersTeamsSection orgId={orgId} orgContext={directory} />;

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

test("subject cards group Everyone then users then teams with semantic colors and inherited team filtering", async () => {
  const grants = [grant({ type: "team", teamId }), grant({ type: "organization" }, "org-grant"), grant({ type: "member", memberId }, "person-grant"), grant({ type: "team", teamId: "other-team" }, "other-grant")];
  const assignments = [{ id: "org-limit", organization: true, memberId: null, teamId: null }];
  const view = await mount(subjectSection(), (call) => call.path === providersPath ? { payload: { inferenceProviders: [provider(grants)] } } : call.path === policiesPath ? { payload: { policies: [policy(assignments)] } } : reply(call));
  try {
    expect(subjects()).toEqual(["organization", `member:${memberId}`, `team:${teamId}`, "team:other-team"]);
    for (const [subject, label, color] of [["organization", "Everyone", "text-emerald-700"], [`member:${memberId}`, "User", "text-blue-700"], [`team:${teamId}`, "Team", "text-amber-700"]]) {
      const card = view.container.querySelector(`[data-subject="${subject}"]`);
      expect([...card?.querySelectorAll("header span") ?? []].some((element) => element.textContent === label && element.classList.contains(color))).toBe(true);
      expect(card?.textContent).toContain("Selected models / Shared upstream");
      expect(card?.querySelector('[aria-label="Group models"]')?.textContent).toContain("model-one");
    }
    expect(view.container.querySelector('[data-subject="organization"]')?.textContent).toContain("$100.000001");
    await choose("Filter users and teams", "Example Person");
    expect(subjects()).toEqual([`member:${memberId}`, `team:${teamId}`]);
    expect(view.container.querySelector(`[data-subject="team:${teamId}"] header`)?.textContent).toContain("Inherited");
    expect(view.container.querySelector(`[data-subject="member:${memberId}"] header`)?.textContent).not.toContain("Inherited");
    await choose("Filter users and teams", "Alpha Team");
    expect(subjects()).toEqual([`team:${teamId}`]);
    await choose("Filter users and teams", "Everyone");
    expect(subjects()).toEqual(["organization"]);
    await choose("Filter users and teams", "All users and teams");
    expect(subjects()).toHaveLength(4);
    expect(writes(view.calls)).toEqual([]);
  } finally { await view.close(); }
});

test.each(["organization", "member", "team"] satisfies GatewayAudience["type"][])("access picker grants only the selected %s using its group and upstream key", async (kind) => {
  const grants: GatewayAccessGrant[] = [];
  const view = await mount(subjectSection(), (call) => {
    if (call.path === providersPath) return { payload: { inferenceProviders: [provider(grants)] } };
    if (call.path === grantsPath && call.init.method === "POST") {
      const created = { id: "created-grant", ...JSON.parse(String(call.init.body)) };
      grants.push(created);
      return { payload: { accessGrant: created } };
    }
    return reply(call);
  });
  try {
    await click("Add new access policy");
    expect(button("Continue").disabled).toBe(true);
    expect(button("Everyone in Fixture Workspace").getAttribute("aria-checked")).toBe("false");
    await selectSubject(kind);
    expect(button("Save access policy").disabled).toBe(true);
    await choose("Provider", "Fixture Provider");
    expect(document.querySelector<HTMLInputElement>('[aria-label="Upstream key"]')?.value).toBe("Shared upstream");
    expect(button("Save access policy").disabled).toBe(true);
    await choose("Model group", "Selected models");
    await click("Save access policy");
    const audience = kind === "organization" ? { type: kind } : kind === "member" ? { type: kind, memberId } : { type: kind, teamId };
    expect(writes(view.calls)).toHaveLength(1);
    expect(JSON.parse(String(writes(view.calls)[0].init.body))).toEqual({ audience, modelGroupId: "group-fixture", credentialSetId: "key-fixture" });
    expect(writes(view.calls)[0].path).toBe(grantsPath);
    expect(view.reauth).toEqual(["assign-gateway-subject-access"]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(subjects()).toEqual([kind === "organization" ? "organization" : kind === "member" ? `member:${memberId}` : `team:${teamId}`]);
    expect(view.calls.filter((call) => call.path === providersPath)).toHaveLength(2);
    for (const call of view.calls) expect(new Headers(call.init.headers).get(ORG_SCOPE_HEADER)).toBe(orgId);
  } finally { await view.close(); }
});

test("multiple upstream keys require an explicit choice and provider changes clear dependent selections", async () => {
  const first = provider();
  first.credentialSets.push({ ...first.credentialSets[0], id: "second-key", name: "Private upstream" });
  const second = { ...provider(), id: "second-provider", name: "Second provider", modelGroups: [], credentialSets: [] };
  const view = await mount(subjectSection(), (call) => {
    if (call.path === providersPath) return { payload: { inferenceProviders: [first, second] } };
    if (call.path === grantsPath && call.init.method === "POST") return { payload: { accessGrant: { id: "new-grant", ...JSON.parse(String(call.init.body)) } } };
    return reply(call);
  });
  try {
    await click("Add new access policy");
    await selectSubject("member");
    await choose("Provider", "Fixture Provider");
    await choose("Model group", "Selected models");
    expect(button("Save access policy").disabled).toBe(true);
    await choose("Upstream key", "Private upstream");
    expect(button("Save access policy").disabled).toBe(false);
    await choose("Provider", "Second provider");
    expect(document.querySelector<HTMLInputElement>('[aria-label="Model group"]')?.value).toBe("");
    expect(document.querySelector<HTMLInputElement>('[aria-label="Upstream key"]')?.value).toBe("");
    expect(button("Save access policy").disabled).toBe(true);
    await choose("Provider", "Fixture Provider");
    await choose("Model group", "Selected models");
    await choose("Upstream key", "Private upstream");
    await click("Save access policy");
    expect(writes(view.calls)).toHaveLength(1);
    expect(JSON.parse(String(writes(view.calls)[0].init.body))).toEqual({ audience: { type: "member", memberId }, modelGroupId: "group-fixture", credentialSetId: "second-key" });
  } finally { await view.close(); }
});

test.each(["organization", "member", "team"] satisfies GatewayAudience["type"][])("usage limit %s assignment and removal move to subject cards without changing target IDs", async (kind) => {
  let current = policy();
  const path = `${policiesPath}/policy-fixture/assignments`;
  const view = await mount(subjectSection(), (call) => {
    if (call.path === policiesPath) return { payload: { policies: [current] } };
    if (call.path === path && call.init.method === "POST") {
      current = { ...current, assignments: [{ id: "assigned", memberId: null, teamId: null, ...JSON.parse(String(call.init.body)) }] };
      return { payload: current };
    }
    if (call.path === `${path}/assigned` && call.init.method === "DELETE") { current = policy(); return { payload: current }; }
    return reply(call);
  });
  try {
    await click("Apply new usage limit");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("each current member and anyone who joins later");
    expect(button("Continue").disabled).toBe(true);
    await selectSubject(kind);
    await choose("Usage limit policy", "Standard");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("$100.000001");
    await click("Apply usage limit");
    const target = kind === "organization" ? { organization: true } : kind === "member" ? { memberId } : { teamId };
    expect(JSON.parse(String(writes(view.calls)[0].init.body))).toEqual(target);
    expect(writes(view.calls)[0].path).toBe(path);
    const name = kind === "organization" ? "Everyone" : kind === "member" ? "Example Person" : "Alpha Team";
    await click(`Unassign Standard from ${name}`);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Only this assignment will be removed");
    expect(writes(view.calls)).toHaveLength(1);
    await click("Unassign limit");
    expect(writes(view.calls)[1]).toMatchObject({ path: `${path}/assigned`, init: { method: "DELETE" } });
    expect(subjects()).toEqual([]);
    expect(view.calls.filter((call) => call.path === policiesPath)).toHaveLength(3);
    for (const call of writes(view.calls)) expect(new Headers(call.init.headers).get(ORG_SCOPE_HEADER)).toBe(orgId);
  } finally { await view.close(); }
});

test("failed assignment reads block both editors until a successful explicit refresh", async () => {
  let failed = true;
  const view = await mount(subjectSection(), (call) => call.path === providersPath && failed ? { status: 403, payload: { error: "forbidden", message: "Only admins may manage provider access" } } : reply(call));
  try {
    expect(view.container.textContent).toContain("Only admins may manage provider access");
    expect(view.container.textContent).not.toContain("No access or usage limit assignments yet");
    expect(button("Add new access policy").disabled).toBe(true);
    expect(button("Apply new usage limit").disabled).toBe(true);
    expect(writes(view.calls)).toEqual([]);
    failed = false;
    await click("Refresh assignments");
    expect(button("Apply new usage limit").disabled).toBe(false);
    expect(view.container.textContent).toContain("No access or usage limit assignments yet");
  } finally { await view.close(); }
});

test("duplicate grants cannot be saved and removal deletes only the confirmed grant through reauthentication", async () => {
  let grants = [grant({ type: "member", memberId }, "grant/id"), grant({ type: "team", teamId }, "team-grant")];
  const view = await mount(subjectSection(), (call) => {
    if (call.path === providersPath) return { payload: { inferenceProviders: [provider(grants)] } };
    if (call.path === `${grantsPath}/grant%2Fid` && call.init.method === "DELETE") { grants = grants.slice(1); return { status: 204, payload: null }; }
    return reply(call);
  });
  try {
    await click("Add new access policy");
    await selectSubject("member");
    await choose("Provider", "Fixture Provider");
    await choose("Model group", "Selected models");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("This assignment already exists");
    expect(button("Save access policy").disabled).toBe(true);
    await click("Cancel");
    await click("Remove Fixture Provider / Selected models / Shared upstream from Example Person");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Other direct, team and Everyone grants remain");
    expect(writes(view.calls)).toEqual([]);
    await click("Remove access");
    expect(writes(view.calls)).toHaveLength(1);
    expect(writes(view.calls)[0]).toMatchObject({ path: `${grantsPath}/grant%2Fid`, init: { method: "DELETE" } });
    expect(new Headers(writes(view.calls)[0].init.headers).get(ORG_SCOPE_HEADER)).toBe(orgId);
    expect(view.reauth).toEqual(["remove-gateway-subject-access"]);
    expect(subjects()).toEqual([`team:${teamId}`]);
  } finally { await view.close(); }
});

test("policy revision changes require reselection and duplicate organization limits stay blocked", async () => {
  let current = policy();
  const view = await mount(subjectSection(), (call) => call.path === policiesPath ? { payload: { policies: [current] } } : reply(call));
  try {
    await click("Apply new usage limit");
    await selectSubject("organization");
    await choose("Usage limit policy", "Standard");
    current = { ...current, revision: 8, limits: [{ timeframe: "month", costLimitMicroUsd: 200_000_000 }] };
    await act(async () => { await view.client.invalidateQueries({ queryKey: ["gateway-usage-limits", orgId, "policies"] }); });
    await tick();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("This policy changed");
    expect(button("Apply usage limit").disabled).toBe(true);
    await choose("Usage limit policy", "Standard");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("$200.00");
    expect(button("Apply usage limit").disabled).toBe(false);
    current = { ...current, assignments: [{ id: "existing", organization: true, memberId: null, teamId: null }] };
    await act(async () => { await view.client.invalidateQueries({ queryKey: ["gateway-usage-limits", orgId, "policies"] }); });
    await tick();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("This assignment already exists");
    expect(button("Apply usage limit").disabled).toBe(true);
    expect(writes(view.calls)).toEqual([]);
  } finally { await view.close(); }
});

test("unverifiable provider definitions cannot masquerade as an empty assignment directory", async () => {
  const view = await mount(subjectSection(), (call) => call.path === providersPath ? { payload: { inferenceProviders: [{ ...provider(), credentialSets: null }] } } : reply(call));
  try {
    expect(view.container.textContent).toContain("Provider access definitions are unavailable");
    expect(view.container.textContent).not.toContain("No access or usage limit assignments yet");
    expect(button("Add new access policy").disabled).toBe(true);
    expect(button("Apply new usage limit").disabled).toBe(true);
    expect(writes(view.calls)).toEqual([]);
  } finally { await view.close(); }
});

test.each(["POST", "DELETE"])("thrown %s reauthentication reaches runReauthableAction as the same error instance", async (method) => {
  const error = new requests.ReauthRequiredError("Verify your identity", "session_expired");
  const view = await mount(subjectSection(), (call) => {
    if (call.init.method === method) throw error;
    if (call.path === providersPath) return { payload: { inferenceProviders: [provider(method === "DELETE" ? [grant({ type: "member", memberId })] : [])] } };
    return reply(call);
  });
  try {
    if (method === "POST") {
      await click("Add new access policy");
      await selectSubject("member");
      await choose("Provider", "Fixture Provider");
      await choose("Model group", "Selected models");
      await click("Save access policy");
    } else {
      await click("Remove Fixture Provider / Selected models / Shared upstream from Example Person");
      await click("Remove access");
    }
    expect(writes(view.calls)).toHaveLength(1);
    expect(writes(view.calls)[0]).toMatchObject({ path: method === "POST" ? grantsPath : `${grantsPath}/grant-fixture`, init: { method } });
    expect(view.reauth).toEqual([method === "POST" ? "assign-gateway-subject-access" : "remove-gateway-subject-access"]);
    expect(view.reauthErrors).toHaveLength(1);
    expect(view.reauthErrors[0]).toBe(error);
    expect(requests.isReauthRequiredError(view.reauthErrors[0])).toBe(true);
    expect(view.reauthErrors[0]).not.toBeInstanceOf(GatewayAccessWriteUncertainError);
    expect(document.body.textContent).not.toContain("may already have succeeded");
  } finally { await view.close(); }
});

test.each(["POST", "DELETE"])("thrown %s transport errors remain uncertain access writes", async (method) => {
  const error = new TypeError("Connection lost");
  const request = spyOn(requests, "requestJson").mockRejectedValue(error);
  try {
    expect(requests.isReauthRequiredError(error)).toBe(false);
    await expect(writeSubjectAccess(orgId, "provider/fixture", method === "POST"
      ? { body: { audience: { type: "member", memberId }, modelGroupId: "group-fixture", credentialSetId: "key-fixture" } }
      : { grantId: "grant-fixture" })).rejects.toBeInstanceOf(GatewayAccessWriteUncertainError);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(method === "POST" ? grantsPath : `${grantsPath}/grant-fixture`, expect.objectContaining({ method }), 20000);
  } finally { request.mockRestore(); }
});

test("unknown access write outcome cannot be retried until assignments are explicitly reviewed", async () => {
  const view = await mount(subjectSection(), (call) => {
    if (call.init.method === "POST") throw new Error("Connection lost");
    return reply(call);
  });
  try {
    await click("Add new access policy");
    await selectSubject("member");
    await choose("Provider", "Fixture Provider");
    await choose("Model group", "Selected models");
    await click("Save access policy");
    expect(document.body.textContent).toContain("may already have succeeded");
    expect(button("Save access policy").disabled).toBe(true);
    await click("Save access policy");
    expect(writes(view.calls)).toHaveLength(1);
    await click("Close and review");
    expect(button("Add new access policy").disabled).toBe(true);
    await click("Refresh assignments");
    expect(button("Add new access policy").disabled).toBe(false);
    expect(writes(view.calls)).toHaveLength(1);
  } finally { await view.close(); }
});
